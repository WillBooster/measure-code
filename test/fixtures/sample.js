class Score {}

function score(value) {
  // ignore negative input
  if (value < 0 || value == null) {
    return 0;
  }
  return value > 10 ? 10 : value;
}
