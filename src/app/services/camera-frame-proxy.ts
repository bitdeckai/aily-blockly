interface ProxyResult { success: boolean; message?: string; url?: string; lastDataAt?: number; }
export interface CameraFrameProxyApi {
  start(address: string): Promise<ProxyResult>;
  stop(url: string): Promise<ProxyResult>;
  status(url: string): Promise<ProxyResult>;
}
export function cameraFrameProxyApi(): CameraFrameProxyApi {
  const bridge: unknown = window['electronAPI'];
  const api: unknown = typeof bridge === 'object' && bridge !== null && 'cameraPreview' in bridge ? bridge.cameraPreview : null;
  if (typeof api === 'object' && api !== null && 'start' in api && typeof api.start === 'function'
    && 'stop' in api && typeof api.stop === 'function' && 'status' in api && typeof api.status === 'function') {
    return api as CameraFrameProxyApi;
  }
  throw new Error('CAMERA_GESTURE.RESTART_DESKTOP');
}
