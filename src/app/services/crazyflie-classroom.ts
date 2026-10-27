export function getClassroomDeskLayout() {
  const rows = 4;
  const cols = 5;
  const deskW = 0.6;
  const deskD = 0.4;
  const rowSpacing = 1.3;
  const colSpacing = 1.1;
  const colCenters = Array.from({ length: cols }, (_, index) => (index - (cols - 1) / 2) * colSpacing);
  const helipadRow = 1;
  const helipadCol = 2;
  const firstRowX = -rowSpacing * helipadRow;
  return {
    rows,
    cols,
    deskW,
    deskD,
    rowSpacing,
    colCenters,
    firstRowX,
    chairOffsetX: deskD / 2 + 0.2,
    helipadRow,
    helipadCol,
    helipadPose: {
      x: firstRowX + rowSpacing * helipadRow,
      y: 0.76573,
      z: colCenters[helipadCol],
      yaw: 0,
    },
  };
}
