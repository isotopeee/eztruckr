/**
 * IANA zone the UI renders in. Storage is always UTC.
 *
 * In its own module rather than in the barrel because the shipment-number
 * generator needs it, and importing the barrel from inside the barrel is a
 * cycle. One declaration, two consumers.
 */
export const APP_TIMEZONE = 'Asia/Manila';
