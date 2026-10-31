import { CameraGesture, isCameraSwipe } from '../../../../../../services/camera-gesture';

export function cameraGestureIllustration(gesture: CameraGesture): string {
  const finger = (x: number, y: number, height: number) => `<rect x="${x}" y="${y}" width="9" height="${height}" rx="4.5"/>`;
  const palm = '<rect x="18" y="30" width="36" height="29" rx="11"/><path d="M26 55v10h20V55"/>';
  const thumb = '<path d="M24 44L14 31Q8 27 8 35L17 52Q19 57 25 55"/>';
  const folded = [18, 27, 36, 45].map(x => finger(x, 26, 21)).join('');
  const open = `${palm}${finger(18, 12, 34)}${finger(27, 5, 40)}${finger(36, 9, 36)}${finger(45, 18, 28)}${thumb}`;
  let hand: string;
  switch (gesture) {
    case 'Closed_Fist': hand = `${palm}${folded}${thumb}`; break;
    case 'Pointing_Up': hand = `${palm}${folded}${finger(18, 5, 40)}${thumb}`; break;
    case 'Thumb_Up':
    case 'Thumb_Down':
      hand = `${palm}${folded}${finger(9, 6, 40)}`;
      if (gesture === 'Thumb_Down') hand = `<g transform="rotate(180 32 36)">${hand}</g>`;
      break;
    case 'Victory': hand = `${palm}${folded}${finger(18, 5, 40)}${finger(30, 8, 36)}${thumb}`; break;
    case 'ILoveYou': hand = `${palm}${folded}${finger(18, 5, 40)}${finger(45, 12, 34)}${thumb}`; break;
    case 'OK':
      hand = `${palm}${finger(27, 5, 40)}${finger(36, 9, 36)}${finger(45, 18, 28)}<circle cx="17" cy="37" r="10" fill="none" stroke-width="7"/>`;
      break;
    default: hand = open;
  }
  if (isCameraSwipe(gesture)) {
    const rotation = { Swipe_Right: 0, Swipe_Left: 180, Swipe_Up: -90, Swipe_Down: 90 }[gesture];
    hand = `<g transform="translate(5 0) scale(.78)">${hand}</g><path transform="rotate(${rotation} 36 56)" d="M20 56h32m-9-9 9 9-9 9" fill="none" stroke="#fff" stroke-width="6"/><path transform="rotate(${rotation} 36 56)" d="M20 56h32m-9-9 9 9-9 9" fill="none" stroke="#2587cb" stroke-width="3"/>`;
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="72" viewBox="0 0 64 72"><g fill="#f7cf9b" stroke="#27313a" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">${hand}</g></svg>`)}`;
}
