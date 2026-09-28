import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL, fetchFile } from "@ffmpeg/util";
import wasmAsset from "../../public/ffmpeg/ffmpeg-core.wasm.asset.json";

export const MAX_VIDEO_SIZE_MB = 50;
export const MAX_VIDEO_BYTES = MAX_VIDEO_SIZE_MB * 1024 * 1024;
export const ALLOWED_VIDEO_MIME_TYPES = ["video/mp4", "video/webm", "video/quicktime"];

let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoadingPromise: Promise<FFmpeg> | null = null;

async function getFFmpeg() {
  if (ffmpegInstance) return ffmpegInstance;

  if (!ffmpegLoadingPromise) {
    ffmpegLoadingPromise = (async () => {
      const ffmpeg = new FFmpeg();

      const baseURL = `${window.location.origin}/ffmpeg`;

      await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(wasmAsset.url, "application/wasm"),
      });

      ffmpegInstance = ffmpeg;
      return ffmpeg;
    })();
  }

  return ffmpegLoadingPromise;
}

export async function getVideoDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      resolve({ width: video.videoWidth, height: video.videoHeight });
      URL.revokeObjectURL(video.src);
    };
    video.onerror = () => {
      reject(new Error("Failed to load video metadata"));
      URL.revokeObjectURL(video.src);
    };
    video.src = URL.createObjectURL(file);
  });
}

export async function compressVideoInBrowser(
  file: File,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
): Promise<File> {
  if (signal?.aborted) {
    throw new Error("AbortError");
  }

  const ffmpeg = await getFFmpeg();

  const abortHandler = () => {
    try {
      ffmpeg.terminate();
    } catch (e) {
      console.error("Error terminating FFmpeg:", e);
    }
    ffmpegInstance = null; // force reload next time
    ffmpegLoadingPromise = null;
  };

  if (signal) {
    signal.addEventListener("abort", abortHandler);
  }

  // Bind the progress event for this specific compression run
  const progressHandler = ({ progress }: { progress: number }) => {
    if (onProgress) {
      // ffmpeg progress is from 0 to 1
      onProgress(Math.round(progress * 100));
    }
  };
  ffmpeg.on("progress", progressHandler);

  const logHandler = ({ message }: { message: string }) => {
    console.log("FFmpeg Log:", message);
  };
  ffmpeg.on("log", logHandler);

  let inputName = "input.mp4";
  let outputName = "output.mp4";

  try {
    const { name } = file;
    // Extract extension or default to mp4
    const extMatch = name.match(/\.([^.]+)$/);
    const ext = extMatch ? extMatch[1].toLowerCase() : "mp4";

    inputName = `input_${Date.now()}.${ext}`;
    outputName = `compressed_${Date.now()}.mp4`;

    await ffmpeg.writeFile(inputName, await fetchFile(file));

    // Compression command:
    // -vf scale=-2:720 (scale to 720p height, keep aspect ratio)
    // -c:v libx264 (H.264 codec)
    // -b:v 1M (1 Mbps bitrate)
    // -preset ultrafast (fastest compression)
    const ret = await ffmpeg.exec([
      "-i",
      inputName,
      "-vf",
      "scale=-2:720",
      "-c:v",
      "libx264",
      "-b:v",
      "1M",
      "-preset",
      "ultrafast",
      outputName,
    ]);

    if (signal?.aborted) {
      throw new Error("AbortError");
    }

    if (ret !== 0) {
      throw new Error(`FFmpeg process failed with exit code ${ret}. Check console for logs.`);
    }

    const data = await ffmpeg.readFile(outputName);

    // Clean up memory
    await ffmpeg.deleteFile(inputName);
    await ffmpeg.deleteFile(outputName);

    return new File([new Uint8Array(data as Uint8Array)], outputName, { type: "video/mp4" });
  } finally {
    // Unbind to prevent memory leaks or duplicate calls on subsequent compressions
    if (ffmpeg) {
      ffmpeg.off("progress", progressHandler);
      ffmpeg.off("log", logHandler);
      // Try to clean up files just in case
      try {
        await ffmpeg.deleteFile(inputName);
      } catch (e) {
        // intentionally empty
      }
      try {
        await ffmpeg.deleteFile(outputName);
      } catch (e) {
        // intentionally empty
      }
    }
    if (signal) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}
