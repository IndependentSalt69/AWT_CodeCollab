#!/usr/bin/env python3
"""
CodeCollab Python 3.11 Code Runner
Executes submitted Python source code and streams stdout/stderr/exitCode.
"""

import os
import sys
import subprocess
from pathlib import Path

TEMP_FILE_PATH = Path("/tmp/_codecollab_submission.py" if os.name != "nt" else "./_temp_submission.py")


def find_submission_file():
    """
    Identifies the submission file to execute based on CLI args,
    environment variables, or default convention paths.
    """
    # 1. CLI flag: --code "source_code"
    if len(sys.argv) > 2 and sys.argv[1] == "--code":
        TEMP_FILE_PATH.write_text(sys.argv[2], encoding="utf-8")
        return TEMP_FILE_PATH

    # 2. CLI argument: python runner.py /path/to/code.py
    if len(sys.argv) > 1 and not sys.argv[1].startswith("--"):
        path = Path(sys.argv[1])
        if path.exists() and path.is_file():
            return path
        else:
            sys.stderr.write(f"Error: Specified submission file not found: {sys.argv[1]}\n")
            sys.stderr.flush()
            sys.exit(1)

    # 3. Environment variable: SUBMISSION_FILE=/path/to/code.py
    env_file = os.environ.get("SUBMISSION_FILE")
    if env_file:
        path = Path(env_file)
        if path.exists() and path.is_file():
            return path
        else:
            sys.stderr.write(f"Error: SUBMISSION_FILE not found: {env_file}\n")
            sys.stderr.flush()
            sys.exit(1)

    # 4. Default container mount paths
    default_paths = [
        Path("/app/submission.py"),
        Path("/app/submission/code.py"),
        Path("./submission.py"),
    ]
    for p in default_paths:
        if p.exists() and p.is_file():
            return p

    # 5. Inline code via env var SUBMISSION_CODE
    code_env = os.environ.get("SUBMISSION_CODE")
    if code_env is not None:
        TEMP_FILE_PATH.write_text(code_env, encoding="utf-8")
        return TEMP_FILE_PATH

    return None


def execute_submission(submission_path):
    """
    Executes the Python submission file in a subprocess with unbuffered output.
    Propagates stdout, stderr, and returns the exit code.
    """
    try:
        # Run user code in an isolated subprocess with unbuffered streams
        result = subprocess.run(
            [sys.executable, "-u", str(submission_path)],
            stdin=sys.stdin,
            stdout=sys.stdout,
            stderr=sys.stderr,
        )
        return result.returncode
    except Exception as exc:
        sys.stderr.write(f"Runner execution error: {exc}\n")
        sys.stderr.flush()
        return 1
    finally:
        # Clean up temporary file if generated from --code or SUBMISSION_CODE
        if submission_path == TEMP_FILE_PATH and TEMP_FILE_PATH.exists():
            try:
                TEMP_FILE_PATH.unlink()
            except OSError:
                pass


def main():
    submission_path = find_submission_file()

    if not submission_path:
        sys.stderr.write("Error: No Python submission file or code provided to runner.\n")
        sys.stderr.flush()
        sys.exit(1)

    exit_code = execute_submission(submission_path)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
