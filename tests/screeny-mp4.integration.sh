#!/usr/bin/env bash

set -euo pipefail

readonly TEST_NAME=${0##*/}
unset CDPATH
TEST_DIRECTORY=$(cd "$(dirname "$0")" && pwd)
readonly TEST_DIRECTORY
REPOSITORY_ROOT=$(cd "$TEST_DIRECTORY/.." && pwd)
readonly REPOSITORY_ROOT
readonly CONVERTER="$REPOSITORY_ROOT/tools/screeny-mp4"
readonly TEMPORARY_ROOT=${TMPDIR:-/tmp}

test_directory=""
tests_passed=0

fail() {
  printf '%s: FAIL: %s\n' "$TEST_NAME" "$1" >&2
  exit 1
}

pass() {
  tests_passed=$((tests_passed + 1))
  printf 'ok %d - %s\n' "$tests_passed" "$1"
}

assert_equal() {
  local expected=$1
  local actual=$2
  local description=$3

  if [ "$expected" != "$actual" ]; then
    fail "$description (expected '$expected', got '$actual')"
  fi
}

probe_stream_value() {
  local media_path=$1
  local stream_selector=$2
  local field=$3

  ffprobe \
    -v error \
    -select_streams "$stream_selector" \
    -show_entries "stream=$field" \
    -of default=noprint_wrappers=1:nokey=1 \
    "$media_path"
}

cleanup() {
  if [ -z "$test_directory" ] || [ ! -d "$test_directory" ]; then
    return
  fi

  case "$test_directory" in
    "$TEMPORARY_ROOT"/screeny-mp4-test.*) rm -rf "$test_directory" ;;
    *) printf '%s: refusing to remove unexpected test path: %s\n' "$TEST_NAME" "$test_directory" >&2 ;;
  esac
}

command -v ffmpeg >/dev/null 2>&1 || fail "ffmpeg is required."
command -v ffprobe >/dev/null 2>&1 || fail "ffprobe is required."
[ -x "$CONVERTER" ] || fail "converter is not executable: $CONVERTER"

if ! test_directory=$(mktemp -d "$TEMPORARY_ROOT/screeny-mp4-test.XXXXXX"); then
  fail "could not create the test directory."
fi

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

audio_video_input="$test_directory/audio-video.webm"
audio_video_output="$test_directory/audio-video.mp4"

ffmpeg \
  -hide_banner \
  -loglevel error \
  -nostdin \
  -f lavfi \
  -i 'testsrc=size=320x240:rate=60' \
  -f lavfi \
  -i 'sine=frequency=1000:sample_rate=48000' \
  -t 1 \
  -c:v libvpx-vp9 \
  -deadline realtime \
  -cpu-used 8 \
  -c:a libopus \
  "$audio_video_input"

"$CONVERTER" "$audio_video_input" "$audio_video_output"

assert_equal "h264" "$(probe_stream_value "$audio_video_output" v:0 codec_name)" \
  "audio/video output uses H.264"
assert_equal "yuv420p" "$(probe_stream_value "$audio_video_output" v:0 pix_fmt)" \
  "audio/video output uses yuv420p"
assert_equal "30/1" "$(probe_stream_value "$audio_video_output" v:0 avg_frame_rate)" \
  "audio/video output uses 30 fps"
assert_equal "aac" "$(probe_stream_value "$audio_video_output" a:0 codec_name)" \
  "audio/video output uses AAC"
pass "converts video and audio to the SharePoint profile"

video_only_input="$test_directory/video-only.webm"

ffmpeg \
  -hide_banner \
  -loglevel error \
  -nostdin \
  -f lavfi \
  -i 'testsrc=size=320x240:rate=60' \
  -t 1 \
  -c:v libvpx-vp9 \
  -deadline realtime \
  -cpu-used 8 \
  -an \
  "$video_only_input"

"$CONVERTER" "$video_only_input"

video_only_output="$test_directory/video-only.mp4"
[ -s "$video_only_output" ] || fail "derived video-only output was not created."
assert_equal "h264" "$(probe_stream_value "$video_only_output" v:0 codec_name)" \
  "video-only output uses H.264"
assert_equal "" "$(probe_stream_value "$video_only_output" a:0 codec_name)" \
  "video-only output has no audio stream"
pass "derives the output name and supports video without audio"

protected_output="$test_directory/protected.mp4"
printf 'keep-me' >"$protected_output"

if "$CONVERTER" "$audio_video_input" "$protected_output" >/dev/null 2>&1; then
  fail "converter accepted an existing output."
fi

assert_equal "keep-me" "$(<"$protected_output")" "existing output remains unchanged"
pass "refuses to overwrite an existing destination"

invalid_input="$test_directory/invalid.webm"
invalid_output="$test_directory/invalid.mp4"
printf 'not media' >"$invalid_input"

if "$CONVERTER" "$invalid_input" "$invalid_output" >/dev/null 2>&1; then
  fail "converter accepted invalid input."
fi

if [ -e "$invalid_output" ] || [ -L "$invalid_output" ]; then
  fail "failed conversion left its requested destination behind."
fi

pass "does not leave a destination after conversion failure"

printf '1..%d\n' "$tests_passed"
