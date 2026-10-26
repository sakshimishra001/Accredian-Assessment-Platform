"use client";

import { fitWithin } from "@/lib/proctoring/evidence";

/*
 * One still frame from a live camera or screen-share stream, as a JPEG (proctoring evidence, phase
 * 7). A video element and a canvas of its own, used once and released straight away: no frame is
 * kept, nothing is drawn on the page, and the stream itself is untouched. Returns null when there is
 * no frame to take (the track ended, no video yet) — never throws.
 */

const FRAME_TIMEOUT_MS = 3_000;

function firstFrame(video: HTMLVideoElement): Promise<boolean> {
  if (video.readyState >= 2 && video.videoWidth > 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(t);
      video.removeEventListener("loadeddata", onData);
      resolve(ok);
    };
    const onData = () => done(video.videoWidth > 0);
    const t = setTimeout(() => done(false), FRAME_TIMEOUT_MS);
    video.addEventListener("loadeddata", onData);
  });
}

export async function captureFrame(stream: MediaStream, format: { maxWidth: number; maxHeight: number; quality: number }): Promise<Blob | null> {
  if (!stream.getVideoTracks().some((t) => t.readyState === "live")) return null;
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  const canvas = document.createElement("canvas");
  try {
    video.srcObject = stream;
    await video.play().catch(() => {});
    if (!(await firstFrame(video))) return null;
    const { width, height } = fitWithin(video.videoWidth, video.videoHeight, format.maxWidth, format.maxHeight);
    if (!width || !height) return null;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, width, height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", format.quality));
  } catch {
    return null;
  } finally {
    video.pause();
    video.srcObject = null;
    // Release the canvas's pixel memory.
    canvas.width = 0;
    canvas.height = 0;
  }
}
