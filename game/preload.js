/**
 * Preload script for secure IPC communication
 * This safely exposes blink tracking functions to the renderer process
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('blinkTracker', {
  // Start blink tracking
  start: (sessionId) => ipcRenderer.invoke('start-blink-tracking', sessionId),
  
  // Stop blink tracking
  stop: () => ipcRenderer.invoke('stop-blink-tracking'),
  
  // Ping tracker
  ping: () => ipcRenderer.invoke('ping-blink-tracker'),
  
  // Event listeners
  onReady: (callback) => ipcRenderer.on('blink-tracker-ready', (event, data) => callback(data)),
  onBlinkDetected: (callback) => ipcRenderer.on('blink-detected', (event, data) => callback(data)),
  onTrackingStarted: (callback) => ipcRenderer.on('blink-tracking-started', (event, data) => callback(data)),
  onTrackingStopped: (callback) => ipcRenderer.on('blink-tracking-stopped', (event, data) => callback(data)),
  onError: (callback) => ipcRenderer.on('blink-tracker-error', (event, error) => callback(error))
  ,
  // Gaze updates (x,y)
  onGaze: (callback) => ipcRenderer.on('gaze-position', (event, data) => callback(data))
});
