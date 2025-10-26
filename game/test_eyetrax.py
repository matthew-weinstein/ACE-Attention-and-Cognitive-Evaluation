"""
Test script to verify EyeTrax installation and basic functionality
Run this before starting the main application
"""

import sys
import cv2

def test_imports():
    """Test if all required packages are installed"""
    print("Testing imports...")
    try:
        import numpy
        print("✓ numpy installed")
    except ImportError:
        print("✗ numpy not found - run: pip install numpy")
        return False
    
    try:
        import cv2
        print("✓ opencv-python installed")
    except ImportError:
        print("✗ opencv-python not found - run: pip install opencv-python")
        return False
    
    try:
        import eyetrax
        print("✓ eyetrax installed")
    except ImportError:
        print("✗ eyetrax not found - run: pip install eyetrax")
        return False
    
    return True

def test_camera():
    """Test if camera is accessible"""
    print("\nTesting camera...")
    try:
        cap = cv2.VideoCapture(0)
        if not cap.isOpened():
            print("✗ Camera not accessible")
            return False
        
        ret, frame = cap.read()
        if not ret:
            print("✗ Cannot read from camera")
            cap.release()
            return False
        
        print(f"✓ Camera working - Resolution: {frame.shape[1]}x{frame.shape[0]}")
        cap.release()
        return True
        
    except Exception as e:
        print(f"✗ Camera test failed: {e}")
        return False

def test_eyetrax():
    """Test basic EyeTrax functionality"""
    print("\nTesting EyeTrax...")
    try:
        from eyetrax.gaze import GazeEstimator
        from eyetrax.utils.screen import get_screen_size
        
        # Initialize gaze estimator
        gaze_estimator = GazeEstimator()
        print("✓ GazeEstimator initialized")
        
        # Get screen size
        width, height = get_screen_size()
        print(f"✓ Screen size detected: {width}x{height}")
        
        return True
        
    except Exception as e:
        print(f"✗ EyeTrax test failed: {e}")
        return False

def main():
    print("=" * 60)
    print("EyeTrax Installation Test")
    print("=" * 60)
    
    # Run tests
    imports_ok = test_imports()
    if not imports_ok:
        print("\n❌ Import test failed. Please install missing packages.")
        print("Run: pip install -r requirements.txt")
        return False
    
    camera_ok = test_camera()
    if not camera_ok:
        print("\n❌ Camera test failed. Please check your webcam.")
        return False
    
    eyetrax_ok = test_eyetrax()
    if not eyetrax_ok:
        print("\n❌ EyeTrax test failed.")
        return False
    
    print("\n" + "=" * 60)
    print("✅ All tests passed! Eye tracking system is ready.")
    print("=" * 60)
    print("\nYou can now run the application with: npm start")
    return True

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
