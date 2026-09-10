const cp = require('child_process');
const { getFfmpegPath } = require('../src/ffmpegHelper');
const ffmpeg = getFfmpegPath();
console.log('Testing FFmpeg...');

// Let's create a 30s test video with timestamp burnt-in, then transcode starting from 10s and check output
const testFile = 'scratch/test_sample.mp4';
const genArgs = [
  '-y', '-f', 'lavfi', '-i', 'testsrc=duration=30:size=640x360:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=30',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', testFile
];

const gen = cp.spawnSync(ffmpeg, genArgs);
console.log('Sample generation status:', gen.status);

// Now test transcode with -ss 10
const transcodeArgs = [
  '-loglevel', 'warning',
  '-ss', '10',
  '-i', testFile,
  '-c:v', 'copy',
  '-c:a', 'copy',
  '-f', 'mp4',
  '-movflags', 'frag_keyframe+empty_moov+default_base_moof+negative_cts_offsets+delay_moov',
  'scratch/test_out.mp4'
];

const trans = cp.spawnSync(ffmpeg, transcodeArgs);
console.log('Transcode status:', trans.status);

// Probe output duration and start time
const probeArgs = [
  '-v', 'error',
  '-show_entries', 'format=duration,start_time',
  '-of', 'default=noprint_wrappers=1',
  'scratch/test_out.mp4'
];
// Run ffprobe if available or use ffmpeg
const probe = cp.spawnSync(ffmpeg, ['-i', 'scratch/test_out.mp4']);
console.log('Output probe:', probe.stderr.toString().slice(0, 400));
