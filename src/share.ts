/*
 * One frame of whatever the owner picks in Chrome's "Choose what to share"
 * dialog (getDisplayMedia): a tab, a window or the whole screen. The stream
 * is stopped as soon as the frame is drawn, so Chrome's sharing indicator
 * shows for a moment only. Nothing leaves the panel until the owner sends.
 */

export type Frame =
  | { status: 'ok'; image: Blob; name: string }
  /** The owner closed the dialog. */
  | { status: 'cancelled' }
  /** No dialog here (API missing, or not allowed in this context): use the tab menu. */
  | { status: 'unavailable' }
  | { status: 'failed'; error: string };

const SURFACES: Record<string, string> = { browser: 'tab', window: 'window', monitor: 'screen' };

export async function grabFrame(): Promise<Frame> {
  const media = navigator.mediaDevices as MediaDevices | undefined;
  if (!media?.getDisplayMedia) return { status: 'unavailable' };
  let stream: MediaStream;
  try {
    stream = await media.getDisplayMedia({
      video: { displaySurface: 'browser' },
      audio: false,
      // Chrome's options: offer tabs first, never this panel itself, no "switch source" button.
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'exclude',
      preferCurrentTab: false,
    } as DisplayMediaStreamOptions);
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotAllowedError' || name === 'AbortError') return { status: 'cancelled' };
    return { status: 'unavailable' };
  }
  try {
    const track = stream.getVideoTracks()[0];
    if (!track) return { status: 'failed', error: 'nothing was shared' };
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    // The first frame can be a blank one while the source starts: wait for two.
    for (let i = 0; i < 2; i += 1) await nextFrame(video);
    if (!video.videoWidth || !video.videoHeight) return { status: 'failed', error: 'the shared picture was empty' };
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    const image = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!image) return { status: 'failed', error: 'the frame could not be encoded' };
    const surface = SURFACES[String(track.getSettings().displaySurface ?? '')] ?? 'screen';
    const time = new Date().toTimeString().slice(0, 5).replace(':', 'h');
    return { status: 'ok', image, name: `Screenshot of a ${surface} ${time}.png` };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}

function nextFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 500);
    const done = () => { clearTimeout(timer); resolve(); };
    if ('requestVideoFrameCallback' in video) (video as HTMLVideoElement & { requestVideoFrameCallback(cb: () => void): number }).requestVideoFrameCallback(done);
    else setTimeout(done, 100);
  });
}
