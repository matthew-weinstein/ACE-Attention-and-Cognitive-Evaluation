/**
 * Preload script for secure IPC communication
 * This safely exposes eye tracking and blink tracking functions to the renderer process
 */

const { contextBridge, ipcRenderer } = require('electron');

// Eye tracking API
contextBridge.exposeInMainWorld('eyeTracker', {
  // Calibrate the eye tracker
  calibrate: () => ipcRenderer.invoke('calibrate-eye-tracker'),
  
  // Start eye tracking
  start: (sessionId) => ipcRenderer.invoke('start-eye-tracking', sessionId),
  
  // Stop eye tracking
  stop: () => ipcRenderer.invoke('stop-eye-tracking'),
  
  // Ping tracker
  ping: () => ipcRenderer.invoke('ping-eye-tracker'),
  
  // Event listeners
  onReady: (callback) => ipcRenderer.on('eye-tracker-ready', (event, data) => callback(data)),
  onCalibrationStarted: (callback) => ipcRenderer.on('eye-calibration-started', (event, data) => callback(data)),
  onCalibrationInstruction: (callback) => ipcRenderer.on('eye-calibration-instruction', (event, data) => callback(data)),
  onCalibrationCompleted: (callback) => ipcRenderer.on('eye-calibration-completed', (event, data) => callback(data)),
  onGazeDetected: (callback) => ipcRenderer.on('gaze-detected', (event, data) => callback(data)),
  onBlinkDetected: (callback) => ipcRenderer.on('blink-detected', (event, data) => callback(data)),
  onTrackingStarted: (callback) => ipcRenderer.on('eye-tracking-started', (event, data) => callback(data)),
  onTrackingStopped: (callback) => ipcRenderer.on('eye-tracking-stopped', (event, data) => callback(data)),
  onError: (callback) => ipcRenderer.on('eye-tracker-error', (event, error) => callback(error))
});
