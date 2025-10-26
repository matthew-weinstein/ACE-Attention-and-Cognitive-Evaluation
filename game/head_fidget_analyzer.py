"""
Head Movement Analysis Algorithm

Processes raw head orientation data (pitch, yaw, roll) and converts it
into quantified movement metrics.

Movement is measured by:
1. Movement velocity (rate of change in head angles)
2. Movement magnitude (total angular displacement)
3. Movement frequency (discrete movement events)
4. Stillness periods (stable head position)
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
        """Calculate angular velocity with outlier filtering and angle wrapping"""
        if len(angles) < 2:
            return np.array([0])
        
        time_diffs = np.diff(timestamps) / 1000.0
        time_diffs[time_diffs == 0] = 0.001
        time_diffs[time_diffs > 1.0] = 0.001
        
        angle_diffs = np.diff(angles)
        
        # Handle angle wrapping (for yaw/roll crossing ±180° boundary)
        angle_diffs[angle_diffs > 180] -= 360
        angle_diffs[angle_diffs < -180] += 360
        
        velocities = angle_diffs / time_diffs
        
        # Filter unrealistic velocities (sensor noise/errors)
        max_realistic_velocity = 200
        velocities[np.abs(velocities) > max_realistic_velocity] = 0
        
        velocities = np.insert(velocities, 0, 0)
        
        return velocities
    
    def calculate_total_movement(self, pitch_vel, yaw_vel, roll_vel):
        """Calculate weighted total head movement magnitude"""
        pitch_weight = 1.0
        yaw_weight = 1.2
        roll_weight = 0.6
        
        total_movement = np.sqrt(
            (pitch_vel * pitch_weight)**2 + 
            (yaw_vel * yaw_weight)**2 + 
            (roll_vel * roll_weight)**2
        )
        return total_movement
    
    def smooth_signal(self, signal):
        """Dual-pass smoothing: EMA + moving average"""
        if len(signal) < 3:
            return signal
        
        alpha = 2.0 / (self.smoothing_window + 1)
        ema = np.zeros_like(signal)
        ema[0] = signal[0]
        
        for i in range(1, len(signal)):
            ema[i] = alpha * signal[i] + (1 - alpha) * ema[i - 1]
        
        window = min(self.smoothing_window, len(ema))
        if window % 2 == 0:
            window -= 1
        if window < 3:
            window = 3
        
        try:
            smoothed = savgol_filter(ema, window, 2)
        except:
            smoothed = gaussian_filter1d(ema, sigma=1.0)
        
        return smoothed
    
    def detect_movement_events(self, total_movement, timestamps):
        """Detect movement events with adaptive thresholds and event merging"""
        events = []
        in_movement = False
        movement_start = None
        movement_intensity = []
        
        median = np.median(total_movement)
        q3 = np.percentile(total_movement, 75)
        adaptive_threshold = max(self.movement_threshold, median + (q3 - median) * 0.5)
        
        for i, (movement, timestamp) in enumerate(zip(total_movement, timestamps)):
            if movement > adaptive_threshold:
                if not in_movement:
                    in_movement = True
                    movement_start = timestamp
                    movement_intensity = [movement]
                else:
                    movement_intensity.append(movement)
            else:
                if in_movement:
                    duration = timestamp - movement_start
                    if duration >= 100:
                        events.append({
                            'start_time': movement_start,
                            'end_time': timestamp,
                            'duration_ms': duration,
                            'peak_intensity': max(movement_intensity),
                            'avg_intensity': np.mean(movement_intensity)
                        })
                    in_movement = False
        
        if in_movement and movement_start is not None:
            duration = timestamps[-1] - movement_start
            if duration >= 100:
                events.append({
                    'start_time': movement_start,
                    'end_time': timestamps[-1],
                    'duration_ms': duration,
                    'peak_intensity': max(movement_intensity),
                    'avg_intensity': np.mean(movement_intensity)
                })
        
        return self.merge_close_events(events, 200)
    
    def merge_close_events(self, events, max_gap_ms):
        """Merge movement events that are close together"""
        if len(events) == 0:
            return events
        
        merged = [events[0].copy()]
        
        for event in events[1:]:
            last_event = merged[-1]
            gap = event['start_time'] - last_event['end_time']
            
            if gap < max_gap_ms:
                last_event['end_time'] = event['end_time']
                last_event['duration_ms'] = last_event['end_time'] - last_event['start_time']
                last_event['peak_intensity'] = max(last_event['peak_intensity'], event['peak_intensity'])
                last_event['avg_intensity'] = (last_event['avg_intensity'] + event['avg_intensity']) / 2
            else:
                merged.append(event.copy())
        
        return merged
    
    def calculate_fidget_score(self, total_movement, window_size_ms=1000):
        """Calculate movement index using robust IQR-based scaling"""
        if len(total_movement) == 0:
            return np.array([0])
        
        q1 = np.percentile(total_movement, 25)
        q3 = np.percentile(total_movement, 75)
        iqr = q3 - q1
        median = np.median(total_movement)
        
        upper_bound = q3 + (1.5 * iqr)
        max_movement = max(upper_bound, np.percentile(total_movement, 95))
        
        if max_movement == 0 or max_movement == q1:
            return np.zeros_like(total_movement)
        
        adjusted_movement = np.maximum(0, total_movement - median)
        fidget_score = (adjusted_movement / (max_movement - median)) * 100
        fidget_score = np.clip(fidget_score, 0, 100)
        
        return fidget_score
    
    def calculate_stillness_periods(self, total_movement, timestamps, stillness_threshold=1.0, min_duration_ms=2000):
        """Identify stillness periods using adaptive threshold"""
        periods = []
        in_stillness = False
        stillness_start = None
        
        q1 = np.percentile(total_movement, 25)
        adaptive_threshold = max(stillness_threshold, q1 * 1.5)
        
        for i, (movement, timestamp) in enumerate(zip(total_movement, timestamps)):
            if movement < adaptive_threshold:
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
        
        # Calculate velocities with improved algorithm
        pitch_vel = self.calculate_angular_velocity(data['pitch'], data['timestamps'])
        yaw_vel = self.calculate_angular_velocity(data['yaw'], data['timestamps'])
        roll_vel = self.calculate_angular_velocity(data['roll'], data['timestamps'])
        
        # Calculate acceleration (second derivative)
        pitch_accel = self.calculate_angular_velocity(pitch_vel, data['timestamps'])
        yaw_accel = self.calculate_angular_velocity(yaw_vel, data['timestamps'])
        roll_accel = self.calculate_angular_velocity(roll_vel, data['timestamps'])
        
        # Calculate weighted total movement
        total_movement = self.calculate_total_movement(pitch_vel, yaw_vel, roll_vel)
        total_acceleration = self.calculate_total_movement(pitch_accel, yaw_accel, roll_accel)
        
        # Apply dual-pass smoothing
        total_movement_smooth = self.smooth_signal(total_movement)
        
        # Calculate movement index with robust scaling
        fidget_score = self.calculate_fidget_score(total_movement_smooth)
        
        # Detect events with adaptive thresholds
        movement_events = self.detect_movement_events(total_movement_smooth, data['timestamps'])
        stillness_periods = self.calculate_stillness_periods(total_movement_smooth, data['timestamps'])
        
        # Enhanced summary statistics
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
            'average_roll_deviation': float(np.std(data['roll'])),
            'average_velocity': float(np.mean(total_movement)),
            'peak_velocity': float(np.max(total_movement)),
            'average_acceleration': float(np.mean(total_acceleration))
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
            'pitch_acceleration': pitch_accel.tolist(),
            'yaw_acceleration': yaw_accel.tolist(),
            'roll_acceleration': roll_accel.tolist(),
            'total_movement': total_movement.tolist(),
            'total_movement_smooth': total_movement_smooth.tolist(),
            'total_acceleration': total_acceleration.tolist(),
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

