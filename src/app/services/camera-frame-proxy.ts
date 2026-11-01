interface ProxyResult { success: boolean; message?: string; url?: string; lastDataAt?: number; }
export interface CameraFrameProxyApi {
  start(address: string): Promise<ProxyResult>;
  stop(url: string): Promise<ProxyResult>;
  status(url: string): Promise<ProxyResult>;
}

async function invokeProxy(request: () => Promise<ProxyResult>): Promise<ProxyResult> {
  try {
    return await request();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/No handler registered for ['"]camera-preview-(?:start|stop|status)['"]/.test(message)) {
      console.warn('Camera preview IPC is unavailable; restart the desktop app:', message);
      throw new Error('CAMERA_GESTURE.RESTART_DESKTOP');
    }
    throw error;
  }
}

export function cameraFrameProxyApi(): CameraFrameProxyApi {
  const bridge: unknown = window['electronAPI'];
  const api: unknown = typeof bridge === 'object' && bridge !== null && 'cameraPreview' in bridge ? bridge.cameraPreview : null;
  if (typeof api === 'object' && api !== null && 'start' in api && typeof api.start === 'function'
    && 'stop' in api && typeof api.stop === 'function' && 'status' in api && typeof api.status === 'function') {
    const proxy = api as CameraFrameProxyApi;
    return {
      start: address => invokeProxy(() => proxy.start(address)),
      stop: url => invokeProxy(() => proxy.stop(url)),
      status: url => invokeProxy(() => proxy.status(url)),
    };
  }
  throw new Error('CAMERA_GESTURE.RESTART_DESKTOP');
}
