import { app, BrowserWindow, Tray, Menu, ipcMain } from 'electron'
import { WebSocketServer } from 'ws'
import path from 'path'
import os from 'os'
import Store from 'electron-store'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import AutoLaunch from 'electron-auto-launch'
import {
	setVolume,
	getVolume,
	mute,
	unmute,
	toggleMute,
	isMuted,
	increaseVolume,
	decreaseVolume,
} from './volumeController.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
	app.quit()
} else {
	let wss
	const store = new Store()
	const currentVersion = '1.0.0'

	let config = store.get('settings') || {
		websocket: { port: 2501 },
		runOnStartup: false,
		polling: { enabled: true, interval: 1000 },
		version: currentVersion,
	}

	if (config.version !== currentVersion) {
		config.version = currentVersion
		store.set('settings', config)
	}

	const appAutoLauncher = new AutoLaunch({
		name: 'Remote Volume',
	})

	const setAutoLaunch = async (enabled) => {
		if (enabled) {
			const isEnabled = await appAutoLauncher.isEnabled()
			if (!isEnabled) {
				await appAutoLauncher.enable()
			}
		} else {
			const isEnabled = await appAutoLauncher.isEnabled()
			if (isEnabled) {
				await appAutoLauncher.disable()
			}
		}
	}

	let mainWindow
	let tray

	function createWindow() {
		mainWindow = new BrowserWindow({
			width: 400,
			height: 520,
			resizable: false,
			webPreferences: {
				contextIsolation: true,
				enableRemoteModule: false,
				preload: path.join(__dirname, 'renderer.js'),
			},
			show: true,
			icon: path.join(__dirname, 'icon.ico'),
		})

		mainWindow.loadFile('index.html')
		mainWindow.setMenu(null)

		mainWindow.on('close', (event) => {
			if (!app.isQuiting) {
				event.preventDefault()
				mainWindow.hide()
			}
		})

		app.on('activate', () => {
			if (BrowserWindow.getAllWindows().length === 0) {
				createWindow()
			} else {
				mainWindow.show()
			}
		})
	}

	app.on('ready', async () => {
		createWindow()
		if (os.platform() === 'darwin') {
			app.dock.hide()
		}
		mainWindow.webContents.on('did-finish-load', () => {
			mainWindow.webContents.send('load-config', config)
		})

		tray = new Tray(path.join(__dirname, 'menuicon.png'))
		const contextMenu = Menu.buildFromTemplate([
			{
				label: 'Show App',
				click: () => {
					mainWindow.show()
				},
			},
			{
				label: 'Quit',
				click: () => {
					app.isQuiting = true
					app.quit()
				},
			},
		])

		tray.setToolTip('Your Application Name')
		tray.setContextMenu(contextMenu)

		await setAutoLaunch(config.runOnStartup)
		startWebSocketServer()

		ipcMain.on('save-config', async (event, newConfig) => {
			config = newConfig
			store.set('settings', config)
			event.reply('config-saved', 'Configuration saved successfully!')

			await setAutoLaunch(config.runOnStartup)

			if (wss) {
				wss.clients.forEach((client) => {
					client.close()
				})
				wss.close(() => {
					console.log('WebSocket server closed. Rebuilding server...')
					startWebSocketServer()
				})
			} else {
				startWebSocketServer()
			}

			startMonitoring()
		})
	})

	let lastVolume = null
	let lastMuteState = null
	let pollingInterval = null

	function startMonitoring() {
		if (pollingInterval) clearInterval(pollingInterval)

		if (config.polling.enabled) {
			pollingInterval = setInterval(async () => {
				try {
					const currentVolume = await getVolume()
					const currentMuteState = await isMuted()

					if (currentVolume !== lastVolume) {
						lastVolume = currentVolume
						broadcastState({ volume: currentVolume })
					}

					if (currentMuteState !== lastMuteState) {
						lastMuteState = currentMuteState
						broadcastState({ muted: currentMuteState })
					}
				} catch (error) {
					console.error('Error monitoring volume/mute state:', error)
				}
			}, config.polling.interval)
		}
	}

	function broadcastState(state) {
		if (wss && wss.clients) {
			wss.clients.forEach((client) => {
				if (client.readyState === client.OPEN) {
					client.send(JSON.stringify(state))
				}
			})
		}
	}

	function startWebSocketServer() {
		const port = config.websocket.port

		if (typeof port !== 'number' || port <= 0) {
			console.error('Invalid port specified in the configuration.')
			return
		}

		wss = new WebSocketServer({ port })

		wss.on('connection', (ws) => {
			console.log('Client connected')
			ws.send(JSON.stringify({ volume: lastVolume, muted: lastMuteState }))

			ws.on('message', async (message) => {
				try {
					const { action, value } = JSON.parse(message)
					let response

					switch (action) {
						case 'setVolume':
							response = await setVolume(value)
							break
						case 'getVolume':
							response = await getVolume()
							break
						case 'increaseVolume':
							response = await increaseVolume(value)
							break
						case 'decreaseVolume':
							response = await decreaseVolume(value)
							break
						case 'mute':
							response = await mute()
							break
						case 'unmute':
							response = await unmute()
							break
						case 'toggleMute':
							response = await toggleMute()
							break
						case 'isMuted':
							response = await isMuted()
							break
						default:
							response = { error: 'Invalid action' }
					}

					if (response !== undefined) {
						ws.send(JSON.stringify({ action, response }))
					}
				} catch (error) {
					console.error('Error processing message:', error)
					ws.send(JSON.stringify({ error: 'Failed to process message' }))
				}
			})
		})

		startMonitoring()

		wss.on('error', (error) => {
			console.error('WebSocket server error:', error)
		})

		console.log(`WebSocket server is running on ws://localhost:${port}`)
	}

	app.on('window-all-closed', () => {
		if (process.platform !== 'darwin') {
			app.quit()
		}
	})
}