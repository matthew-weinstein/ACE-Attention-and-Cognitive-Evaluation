/**
 * Preload script for secure IPC communication
 * This safely exposes tracking functions to the renderer process
 */

const { contextBridge, ipcRenderer } = require('electron');

// Blink tracking API
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
});

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

// Head tracking API
contextBridge.exposeInMainWorld('headTracker', {
  // Start head tracking
  start: (sessionId) => ipcRenderer.invoke('start-head-tracking', sessionId),
  
  // Stop head tracking
  stop: () => ipcRenderer.invoke('stop-head-tracking'),
  
  // Calibrate head tracker
  calibrate: () => ipcRenderer.invoke('calibrate-head-tracker'),
  
  // Ping tracker
  ping: () => ipcRenderer.invoke('ping-head-tracker'),
  
  // Event listeners
  onReady: (callback) => ipcRenderer.on('head-tracker-ready', (event, data) => callback(data)),
  onHeadPoseDetected: (callback) => ipcRenderer.on('head-pose-detected', (event, data) => callback(data)),
  onTrackingStarted: (callback) => ipcRenderer.on('head-tracking-started', (event, data) => callback(data)),
  onTrackingStopped: (callback) => ipcRenderer.on('head-tracking-stopped', (event, data) => callback(data)),
  onCalibrated: (callback) => ipcRenderer.on('head-tracker-calibrated', (event, data) => callback(data)),
  onError: (callback) => ipcRenderer.on('head-tracker-error', (event, error) => callback(error))
});