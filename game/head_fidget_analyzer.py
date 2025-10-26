`"""
Head Fidgeting Analysis Algorithm

This module processes raw head orientation data (pitch, yaw, roll) and converts it
into meaningful fidgeting metrics that can be visualized over time.

Fidgeting is measured by:
1. Movement velocity (rate of change in head angles)
2. Movement magnitude (total angular displacement)
3. Movement frequency (number of direction changes)
4. Stillness periods (times when head is relatively stable)
"""

import numpy as np
import json
from datetime import datetime
from scipy.signal import savgol_filter
from scipy.ndimage import gaussian_filter1d
import os


class HeadFidgetAnalyzer:
    def __init__(self, smoothing_window=5, movement_threshold=2.0):
        """
        Initialize the fidget analyzer
        
        Args:
            smoothing_window: Window size for smoothing (frames)
            movement_threshold: Minimum angle change to count as movement (degrees)
        """
        self.smoothing_window = smoothing_window
        self.movement_threshold = movement_threshold
    
    def load_head_data(self, log_file_path):
        """
        Load head tracking data from log file
        
        Returns:
            dict with timestamps, pitch, yaw, roll arrays
        """
        timestamps = []
        pitch_values = []
        yaw_values = []
        roll_values = []
        
        with open(log_file_path, 'r') as f:
            # Skip header lines
            lines = f.readlines()
            data_started = False
            
            for line in lines:
                line = line.strip()
                
                # Find where data starts
                if "Timestamp (ms)" in line:
                    data_started = True
                    continue
                
                # Skip header lines
                if not data_started or line.startswith("=") or not line:
                    continue
                
                # Parse data line
                parts = line.split(',')
                if len(parts) >= 4:
                    try:
                        timestamp = int(parts[0].strip())
                        pitch = float(parts[1].strip())
                        yaw = float(parts[2].strip())
                        roll = float(parts[3].strip())
                        
                        timestamps.append(timestamp)
                        pitch_values.append(pitch)
                        yaw_values.append(yaw)
                        roll_values.append(roll)
                    except ValueError:
                        continue
        
        return {
            'timestamps': np.array(timestamps),
            'pitch': np.array(pitch_values),
            'yaw': np.array(yaw_values),
            'roll': np.array(roll_values)
        }
    
    def calculate_angular_velocity(self, angles, timestamps):
        """
        Calculate velocity (rate of change) of angle over time
        
        Args:
            angles: Array of angle values (degrees)
            timestamps: Array of timestamps (milliseconds)
        
        Returns:
            Array of angular velocities (degrees/second)
        """
        if len(angles) < 2:
            return np.array([0])
        
        # Calculate time differences in seconds
        time_diffs = np.diff(timestamps) / 1000.0
        time_diffs[time_diffs == 0] = 0.001  # Avoid division by zero
        
        # Calculate angle differences
        angle_diffs = np.diff(angles)
        
        # Calculate velocity (degrees per second)
        velocities = angle_diffs / time_diffs
        
        # Prepend zero for first value to maintain array length
        velocities = np.insert(velocities, 0, 0)
        
        return velocities
    
    def calculate_total_movement(self, pitch_vel, yaw_vel, roll_vel):
        """
        Calculate total head movement magnitude (combining all axes)
        
        Args:
            pitch_vel, yaw_vel, roll_vel: Angular velocities for each axis
        
        Returns:
            Array of total movement magnitudes
        """
        # Calculate Euclidean norm of velocity vector
        total_movement = np.sqrt(pitch_vel**2 + yaw_vel**2 + roll_vel**2)
        return total_movement
    
    def smooth_signal(self, signal):
        """
        Smooth signal to reduce noise
        
        Args:
            signal: Input signal array
        
        Returns:
            Smoothed signal
        """
        if len(signal) < self.smoothing_window:
            return signal
        
        # Use Savitzky-Golay filter for smoothing
        window = min(self.smoothing_window, len(signal))
        if window % 2 == 0:
            window -= 1  # Must be odd
        if window < 3:
            window = 3
        
        try:
            smoothed = savgol_filter(signal, window, 2)
        except:
            # Fallback to Gaussian smoothing
            smoothed = gaussian_filter1d(signal, sigma=1.0)
        
        return smoothed
    
    def detect_movement_events(self, total_movement, timestamps):
        """
        Detect discrete movement events (fidgets)
        
        Args:
            total_movement: Array of movement magnitudes
            timestamps: Array of timestamps
        
        Returns:
            List of movement events with start time, duration, and intensity
        """
        events = []
        in_movement = False
        movement_start = None
        movement_intensity = []
        
        for i, (movement, timestamp) in enumerate(zip(total_movement, timestamps)):
            if movement > self.movement_threshold:
                if not in_movement:
                    # Start of new movement
                    in_movement = True
                    movement_start = timestamp
                    movement_intensity = [movement]
                else:
                    # Continuation of movement
                    movement_intensity.append(movement)
            else:
                if in_movement:
                    # End of movement
                    events.append({
                        'start_time': movement_start,
                        'end_time': timestamp,
                        'duration_ms': timestamp - movement_start,
                        'peak_intensity': max(movement_intensity),
                        'avg_intensity': np.mean(movement_intensity)
                    })
                    in_movement = False
        
        # Handle case where movement continues to end
        if in_movement and movement_start is not None:
            events.append({
                'start_time': movement_start,
                'end_time': timestamps[-1],
                'duration_ms': timestamps[-1] - movement_start,
                'peak_intensity': max(movement_intensity),
                'avg_intensity': np.mean(movement_intensity)
            })
        
        return events
    
    def calculate_fidget_score(self, total_movement, window_size_ms=1000):
        """
        Calculate fidgeting score over time windows
        
        Args:
            total_movement: Array of movement magnitudes
            window_size_ms: Size of time window in milliseconds
        
        Returns:
            Array of fidget scores (0-100 scale)
        """
        # Use rolling window to calculate average movement
        if len(total_movement) == 0:
            return np.array([0])
        
        # Normalize movement to 0-100 scale
        max_movement = np.percentile(total_movement, 95)  # Use 95th percentile to avoid outliers
        if max_movement == 0:
            return np.zeros_like(total_movement)
        
        fidget_score = (total_movement / max_movement) * 100
        fidget_score = np.clip(fidget_score, 0, 100)
        
        return fidget_score
    
    def calculate_stillness_periods(self, total_movement, timestamps, stillness_threshold=1.0, min_duration_ms=2000):
        """
        Identify periods of stillness (low movement)
        
        Args:
            total_movement: Array of movement magnitudes
            timestamps: Array of timestamps
            stillness_threshold: Maximum movement to be considered still
            min_duration_ms: Minimum duration to count as stillness period
        
        Returns:
            List of stillness periods
        """
        periods = []
        in_stillness = False
        stillness_start = None
        
        for i, (movement, timestamp) in enumerate(zip(total_movement, timestamps)):
            if movement < stillness_threshold:
                if not in_stillness:
                    in_stillness = True
                    stillness_start = timestamp
            else:
                if in_stillness:
                    duration = timestamp - stillness_start
                    if duration >= min_duration_ms:
                        periods.append({
                            'start_time': stillness_start,
                            'end_time': timestamp,
                            'duration_ms': duration
                        })
                    in_stillness = False
        
        # Handle case where stillness continues to end
        if in_stillness and stillness_start is not None:
            duration = timestamps[-1] - stillness_start
            if duration >= min_duration_ms:
                periods.append({
                    'start_time': stillness_start,
                    'end_time': timestamps[-1],
                    'duration_ms': duration
                })
        
        return periods
    
    def analyze(self, log_file_path):
        """
        Main analysis function - processes head data and returns fidgeting metrics
        
        Args:
            log_file_path: Path to head tracking log file
        
        Returns:
            Dictionary containing all analysis results
        """
        # Load data
        data = self.load_head_data(log_file_path)
        
        if len(data['timestamps']) == 0:
            return {
                'error': 'No data found in log file',
                'timestamps': [],
                'fidget_score': [],
                'total_movement': [],
                'movement_events': [],
                'stillness_periods': [],
                'summary': {}
            }
        
        # Calculate velocities for each axis
        pitch_vel = self.calculate_angular_velocity(data['pitch'], data['timestamps'])
        yaw_vel = self.calculate_angular_velocity(data['yaw'], data['timestamps'])
        roll_vel = self.calculate_angular_velocity(data['roll'], data['timestamps'])
        
        # Calculate total movement magnitude
        total_movement = self.calculate_total_movement(pitch_vel, yaw_vel, roll_vel)
        
        # Smooth the signal
        total_movement_smooth = self.smooth_signal(total_movement)
        
        # Calculate fidget score
        fidget_score = self.calculate_fidget_score(total_movement_smooth)
        
        # Detect movement events
        movement_events = self.detect_movement_events(total_movement_smooth, data['timestamps'])
        
        # Detect stillness periods
        stillness_periods = self.calculate_stillness_periods(total_movement_smooth, data['timestamps'])
        
        # Calculate summary statistics
        duration_seconds = (data['timestamps'][-1] - data['timestamps'][0]) / 1000.0
        summary = {
            'total_duration_seconds': duration_seconds,
            'average_fidget_score': float(np.mean(fidget_score)),
            'peak_fidget_score': float(np.max(fidget_score)),
            'total_movement_events': len(movement_events),
            'movement_events_per_minute': len(movement_events) / (duration_seconds / 60.0) if duration_seconds > 0 else 0,
            'total_stillness_periods': len(stillness_periods),
            'total_stillness_duration_seconds': sum([p['duration_ms'] for p in stillness_periods]) / 1000.0,
            'stillness_percentage': (sum([p['duration_ms'] for p in stillness_periods]) / (duration_seconds * 1000.0)) * 100 if duration_seconds > 0 else 0,
            'average_pitch_deviation': float(np.std(data['pitch'])),
            'average_yaw_deviation': float(np.std(data['yaw'])),
            'average_roll_deviation': float(np.std(data['roll']))
        }
        
        # Convert timestamps to relative seconds for easier plotting
        relative_time_seconds = (data['timestamps'] - data['timestamps'][0]) / 1000.0
        
        return {
            'timestamps': data['timestamps'].tolist(),
            'relative_time_seconds': relative_time_seconds.tolist(),
            'pitch': data['pitch'].tolist(),
            'yaw': data['yaw'].tolist(),
            'roll': data['roll'].tolist(),
            'pitch_velocity': pitch_vel.tolist(),
            'yaw_velocity': yaw_vel.tolist(),
            'roll_velocity': roll_vel.tolist(),
            'total_movement': total_movement.tolist(),
            'total_movement_smooth': total_movement_smooth.tolist(),
            'fidget_score': fidget_score.tolist(),
            'movement_events': movement_events,
            'stillness_periods': stillness_periods,
            'summary': summary
        }
    
    def save_analysis(self, analysis_results, output_path):
        """
        Save analysis results to JSON file
        
        Args:
            analysis_results: Results from analyze()
            output_path: Path to save JSON file
        """
        with open(output_path, 'w') as f:
            json.dump(analysis_results, f, indent=2)
        
        print(f"Analysis saved to: {output_path}")


def analyze_all_head_logs(log_directory="head_logs", output_directory="head_analysis"):
    """
    Analyze all head tracking log files in a directory
    
    Args:
        log_directory: Directory containing log files
        output_directory: Directory to save analysis results
    """
    if not os.path.exists(log_directory):
        print(f"Log directory not found: {log_directory}")
        return
    
    if not os.path.exists(output_directory):
        os.makedirs(output_directory)
    
    analyzer = HeadFidgetAnalyzer(smoothing_window=5, movement_threshold=2.0)
    
    # Find all log files
    log_files = [f for f in os.listdir(log_directory) if f.endswith('.log')]
    
    if not log_files:
        print(f"No log files found in {log_directory}")
        return
    
    print(f"Found {len(log_files)} log file(s) to analyze...")
    
    for log_file in log_files:
        log_path = os.path.join(log_directory, log_file)
        print(f"\nAnalyzing: {log_file}")
        
        # Analyze
        results = analyzer.analyze(log_path)
        
        # Print summary
        if 'error' not in results:
            print(f"  Duration: {results['summary']['total_duration_seconds']:.1f}s")
            print(f"  Average Fidget Score: {results['summary']['average_fidget_score']:.1f}/100")
            print(f"  Movement Events: {results['summary']['total_movement_events']}")
            print(f"  Stillness: {results['summary']['stillness_percentage']:.1f}%")
        else:
            print(f"  Error: {results['error']}")
        
        # Save results
        output_file = log_file.replace('.log', '_analysis.json')
        output_path = os.path.join(output_directory, output_file)
        analyzer.save_analysis(results, output_path)
    
    print(f"\n✓ Analysis complete! Results saved to {output_directory}/")


if __name__ == "__main__":
    # Example usage
    analyze_all_head_logs()

