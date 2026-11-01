import type { DeliveryRound, DeliveryState } from '../contracts/delivery.js';

export function currentRound(state: DeliveryState): DeliveryRound {
  const round = state.history.at(-1);
  if (!round || round.round !== state.round)
    throw new Error('Delivery requires a captured current round.');
  return round;
}

export function replaceRound(
  state: DeliveryState,
  round: DeliveryRound,
): DeliveryState {
  const current = currentRound(state);
  if (round.round !== current.round || round.revision !== current.revision)
    throw new Error('Cannot replace the current round with another candidate.');
  return { ...state, history: [...state.history.slice(0, -1), round] };
}
