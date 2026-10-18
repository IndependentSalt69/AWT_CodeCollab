"""Trusted launcher for disposable C++/Java containers, never a host fallback.

The engine bounds the entire container lifetime (compilation + execution), output,
CPU, memory, and PIDs. All writable artifacts live in the disposable /work tmpfs.
"""
import os
import signal
import subprocess
import sys
import tempfile

MAX_CODE_BYTES = 64 * 1024
JAVA_LIMITS = [
    "-Xms16m", "-Xmx96m", "-Xss256k", "-XX:+UseSerialGC",
    "-XX:ActiveProcessorCount=1", "-XX:MaxMetaspaceSize=64m",
    "-XX:ReservedCodeCacheSize=32m", "-XX:-UsePerfData",
    "-XX:+ExitOnOutOfMemoryError",
]


def run_phase(argv, directory):
    # No shell, user filenames, class names, compiler flags, or inherited stdin.
    child = subprocess.Popen(argv, cwd=directory, stdin=subprocess.DEVNULL,
                             start_new_session=True)
    try:
        result = child.wait()
        return result if result >= 0 else 128 - result
    finally:
        # Reap/kill descendants even after a compiler or user program fails.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()


def main():
    if len(sys.argv) != 4 or sys.argv[1] not in ("cpp", "java") or sys.argv[2] != "--code":
        print("Expected language and --code submission", file=sys.stderr)
        return 2
    language, code = sys.argv[1], sys.argv[3]
    if not code.strip() or "\0" in code or len(code.encode("utf-8")) > MAX_CODE_BYTES:
        print("Submission must be non-empty UTF-8 source of at most 64 KiB, without NUL bytes", file=sys.stderr)
        return 2
    if os.getuid() == 0:
        print("Runner refuses to execute as root", file=sys.stderr)
        return 2
    with tempfile.TemporaryDirectory(prefix="submission-", dir="/work") as directory:
        filename = "main.cpp" if language == "cpp" else "Main.java"
        with open(os.path.join(directory, filename), "w", encoding="utf-8") as source:
            source.write(code)
        if language == "cpp":
            compiler = ["g++", "-std=c++17", "-O0", "-pipe", "-fmax-errors=20", "main.cpp", "-o", "program"]
            program = [os.path.join(directory, "program")]
        else:
            compiler = ["javac", *["-J" + flag for flag in JAVA_LIMITS], "-encoding", "UTF-8",
                        "-proc:none", "-d", directory, "Main.java"]
            program = ["java", *JAVA_LIMITS, "-cp", directory, "Main"]
        result = run_phase(compiler, directory)
        if result != 0:
            return result
        return run_phase(program, directory)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        print(f"Runner error: {error}", file=sys.stderr)
        sys.exit(1)
