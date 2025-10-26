"""
Test script for the blink tracker
This simulates commands from the Electron app to test blink detection
"""

import subprocess
import json
import time
import threading
import sys

def read_output(process):
    """Read and print output from the blink tracker"""
    for line in process.stdout:
        try:
            message = json.loads(line.strip())
            msg_type = message.get("type")
            action = message.get("action")
            data = message.get("data", {})
            
            if msg_type == "status":
                print(f"📊 STATUS: {action}")
                if action == "calibrating":
                    print("   ⚠️  Follow the calibration instructions on screen!")
                elif action == "tracking_started":
                    print(f"   ✅ Log file: {data.get('log_file')}")
                elif action == "tracking_stopped":
                    print(f"   ✅ Total blinks: {data.get('total_blinks')}")
                    print(f"   ⏱️  Duration: {data.get('duration_s')}s")
            
            elif msg_type == "blink":
                print(f"👁️  BLINK #{data.get('blink_number')} detected at {data.get('relative_time_s')}s")
            
            elif msg_type == "error":
                print(f"❌ ERROR: {action} - {data.get('message')}")
            
            else:
                print(f"📨 {msg_type}: {action}")
                
        except json.JSONDecodeError:
            print(f"Raw output: {line.strip()}")
        except Exception as e:
            print(f"Error processing output: {e}")

def send_command(process, action, **kwargs):
    """Send a command to the blink tracker"""
    command = {"action": action, **kwargs}
    process.stdin.write(json.dumps(command) + "\n")
    process.stdin.flush()
    print(f"\n>>> Sent command: {action}")

def main():
    print("=" * 60)
    print("🧪 BLINK TRACKER TEST")
    print("=" * 60)
    print("\nStarting blink tracker process...")
    
    # Start the blink tracker process
    process = subprocess.Popen(
        ["python", "blink_tracker.py"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1
    )
    
    # Start thread to read output
    output_thread = threading.Thread(target=read_output, args=(process,), daemon=True)
    output_thread.start()
    
    # Wait for initialization
    time.sleep(2)
    
    try:
        # Send PING to check if it's responsive
        send_command(process, "PING")
        time.sleep(1)
        
        # Start tracking
        print("\n" + "=" * 60)
        print("🎯 STARTING TRACKING SESSION")
        print("=" * 60)
        print("Instructions:")
        print("1. Complete the 9-point calibration by looking at each point")
        print("2. After calibration, try blinking naturally")
        print("3. Watch the console for blink detections")
        print("4. Press Ctrl+C when done to stop tracking")
        print("=" * 60 + "\n")
        
        send_command(process, "START", session_id="test_session")
        
        # Keep running until user interrupts
        while True:
            time.sleep(1)
    
    except KeyboardInterrupt:
        print("\n\n⏹️  Stopping tracking session...")
        send_command(process, "STOP")
        time.sleep(2)
        
        print("\n🛑 Exiting...")
        send_command(process, "EXIT")
        time.sleep(1)
    
    finally:
        process.terminate()
        process.wait()
        print("\n✅ Test complete!")
        print("\n📁 Check the 'blink_logs' folder for the log file")

if __name__ == "__main__":
    main()
