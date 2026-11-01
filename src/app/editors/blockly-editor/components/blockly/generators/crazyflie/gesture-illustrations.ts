import { CameraGesture, isCameraGesture, isCameraSwipe } from '../../../../../../services/camera-gesture';
import * as photos from './gesture-photos.json';

const gesturePhotos: Record<CameraGesture, string> = {
  Open_Palm: photos.Open_Palm,
  Closed_Fist: photos.Closed_Fist,
  Pointing_Up: photos.Pointing_Up,
  Thumb_Up: photos.Thumb_Up,
  Thumb_Down: photos.Thumb_Down,
  Victory: photos.Victory,
  ILoveYou: photos.ILoveYou,
  OK: photos.OK,
  Swipe_Left: photos.Open_Palm,
  Swipe_Right: photos.Open_Palm,
  Swipe_Up: photos.Open_Palm,
  Swipe_Down: photos.Open_Palm,
};

export function cameraGestureIllustration(gesture: CameraGesture): string {
  if (!isCameraGesture(gesture)) throw new Error('CAMERA_GESTURE.INVALID_PROGRAM');
  let arrow = '';
  if (isCameraSwipe(gesture)) {
    const rotation = { Swipe_Right: 0, Swipe_Left: 180, Swipe_Up: -90, Swipe_Down: 90 }[gesture];
    arrow = `<g transform="rotate(${rotation} 48 94)" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M24 94h48m-10-10 10 10-10 10" stroke="#fff" stroke-width="8"/><path d="M24 94h48m-10-10 10 10-10 10" stroke="#58d2ff" stroke-width="4"/></g>`;
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="128" viewBox="0 0 96 128"><image href="${gesturePhotos[gesture]}" width="96" height="128"/>${arrow}</svg>`)}`;
}
