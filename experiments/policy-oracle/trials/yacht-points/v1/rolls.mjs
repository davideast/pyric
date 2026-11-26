export function* rolls() {
  for (let n = 0; n < 6 ** 5; n++) {
    let rest = n;
    const dice = [];
    for (let i = 0; i < 5; i++) {
      dice.push(1 + rest % 6);
      rest = Math.floor(rest / 6);
    }
    yield dice;
  }
}
