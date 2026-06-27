function simple() {
  return 1;
}

function complex(value) {
  if (value > 10) {
    return value;
  }
  return value === 0 ? 1 : value;
}
