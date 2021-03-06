// @flow
import {BrowserWindow, dialog, ipcMain} from 'electron'
import {ApplicationWindow} from './ApplicationWindow'
import {err} from './DesktopErrorHandler.js'
import {defer} from '../api/common/utils/Utils.js'
import type {DeferredObject} from "../api/common/utils/Utils"
import {errorToObj} from "../api/common/WorkerProtocol"
import DesktopUtils from "../desktop/DesktopUtils"
import {conf} from "./DesktopConfigHandler"
import {disableAutoLaunch, enableAutoLaunch, isAutoLaunchEnabled} from "./autolaunch/AutoLauncher"

/**
 * node-side endpoint for communication between the renderer thread and the node thread
 */
class IPC {
	_initialized: Array<DeferredObject<void>>;
	_requestId: number = 0;
	_queue: {[string]: Function};

	constructor() {
		this._initialized = []
		this._queue = {}
	}

	_invokeMethod(windowId: number, method: NativeRequestType, args: Array<Object>): Promise<any> {
		const d = defer()

		switch (method) {
			case 'init':
				if (!this.initialized(windowId).isFulfilled()) {
					this._initialized[windowId].resolve()
				}
				d.resolve(process.platform);
				break
			case 'findInPage':
				this.initialized(windowId).then(() => {
					const w = ApplicationWindow.get(windowId)
					if (w) {
						w.findInPage(args)
					}
				})
				d.resolve()
				break
			case 'stopFindInPage':
				this.initialized(windowId).then(() => {
					const w = ApplicationWindow.get(windowId)
					if (w) {
						w.stopFindInPage()
					}
				})
				d.resolve()
				break
			case 'registerMailto':
				DesktopUtils
					.registerAsMailtoHandler(true)
					.then(() => {
						d.resolve()
					})
					.catch(e => {
						d.reject(e)
					})
				break
			case 'unregisterMailto':
				DesktopUtils
					.unregisterAsMailtoHandler(true)
					.then(() => {
						d.resolve()
					})
					.catch(e => {
						d.reject(e)
					})
				break
			case 'sendDesktopConfig':
				Promise.join(
					DesktopUtils.checkIsMailtoHandler(),
					isAutoLaunchEnabled(),
					(isMailtoHandler, autoLaunchEnabled) => {
						const config = conf.getDesktopConfig()
						config.isMailtoHandler = isMailtoHandler
						config.runOnStartup = autoLaunchEnabled
						return config
					}).then((config) => d.resolve(config))
				break
			case 'openFileChooser':
				if (args[1]) { // open folder dialog
					dialog.showOpenDialog(null, {properties: ['openDirectory']}, paths => {
						d.resolve(paths ? paths : [])
					})
				} else { // open file
					d.resolve([])
				}
				break
			case 'updateDesktopConfig':
				conf.setDesktopConfig(null, args[0]).then(() => d.resolve())
				break
			case 'openNewWindow':
				new ApplicationWindow(true)
				d.resolve()
				break
			case 'showWindow':
				this.initialized(windowId).then(() => {
					const w = ApplicationWindow.get(windowId)
					if (w) {
						w.show()
					}
				}).then(() => d.resolve())
				break
			case 'enableAutoLaunch':
				enableAutoLaunch().then(() => d.resolve())
				break
			case 'disableAutoLaunch':
				disableAutoLaunch().then(() => d.resolve())
				break
			case 'getPushIdentifier':
				// we know there's a logged in window
				err.sendErrorReport(windowId)
				d.resolve()
				break
			default:
				d.reject(new Error(`Invalid Method invocation: ${method}`))
				break
		}

		return d.promise
	}

	sendRequest(windowId: number, type: JsRequestType, args: Array<any>): Promise<Object> {
		return this.initialized(windowId).then(() => {
			const requestId = this._createRequestId();
			const request = {
				id: requestId,
				type: type,
				args: args,
			}

			BrowserWindow.fromId(windowId).webContents.send(`${windowId}`, request)
			const d = defer()
			this._queue[requestId] = d.resolve;
			return d.promise;
		})
	}

	_createRequestId(): string {
		if (this._requestId >= Number.MAX_SAFE_INTEGER) {
			this._requestId = 0
		}
		return "desktop" + this._requestId++
	}

	initialized(windowId: number): Promise<void> {
		if (this._initialized[windowId]) {
			return this._initialized[windowId].promise
		} else {
			return Promise.reject(new Error("Tried to call ipc function on nonexistent window"))
		}
	}

	addWindow(id: number) {
		this._initialized[id] = defer()
		ipcMain.on(`${id}`, (ev: Event, msg: string) => {
			const request = JSON.parse(msg)
			if (request.type === "response") {
				this._queue[request.id](request.value);
			} else {
				this._invokeMethod(id, request.type, request.args)
				    .then(result => {
					    const response = {
						    id: request.id,
						    type: "response",
						    value: result,
					    }
					    BrowserWindow.fromId(id).webContents.send(`${id}`, response)
				    })
				    .catch((e) => {
					    const response = {
						    id: request.id,
						    type: "requestError",
						    error: errorToObj(e),
					    }

					    BrowserWindow.fromId(id).webContents.send(`${id}`, response)
				    })
			}
		})
	}

	removeWindow(id: number) {
		ipcMain.removeAllListeners(`${id}`)
		delete this._initialized[id]
	}
}

export const ipc = new IPC()