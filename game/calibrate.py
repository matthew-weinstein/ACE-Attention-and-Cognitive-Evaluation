"""
Standalone calibration script that runs in a separate process.
Saves the calibration model to gaze_model.pkl for the main tracker to load.
"""
import sys
from eyetrax import GazeEstimator, run_9_point_calibration

def main():
    print("Starting 9-point calibration...", flush=True)
    try:
        estimator = GazeEstimator()
        run_9_point_calibration(estimator)
        estimator.save_model("gaze_model.pkl")
        print("CALIBRATION_SUCCESS", flush=True)
        return 0
    except Exception as e:
        print(f"CALIBRATION_FAILED:{str(e)}", flush=True)
        return 1

if __name__ == "__main__":
    sys.exit(main())
