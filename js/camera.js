/**
 * Request a user-facing webcam stream and attach it to a video element.
 * @param {HTMLVideoElement} video
 * @returns {Promise<MediaStream>}
 */
export async function startCamera(video) {
  if (!navigator.mediaDevices?.getUserMedia) {
    const host = location.hostname;
    const insecureLan =
      location.protocol === "http:" &&
      host !== "localhost" &&
      host !== "127.0.0.1" &&
      host !== "[::1]";
    if (insecureLan || !window.isSecureContext) {
      throw new Error(
        `This page is ${location.origin} (not secure for camera). In the address bar type exactly: http://localhost:${location.port || "3456"}`
      );
    }
    throw new Error(
      "Camera API is not available here. Use desktop Chrome with http://localhost."
    );
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
  } catch (err) {
    throw mapCameraError(err);
  }

  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;

  await video.play();
  return stream;
}

/**
 * @param {unknown} err
 * @returns {Error}
 */
function mapCameraError(err) {
  const name = err && typeof err === "object" && "name" in err ? String(err.name) : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return new Error("Camera permission denied. Allow access and try again.");
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return new Error("No camera device found.");
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return new Error("Camera is already in use by another application.");
  }
  const message =
    err && typeof err === "object" && "message" in err && typeof err.message === "string"
      ? err.message
      : "Could not open the camera.";
  return new Error(message);
}
