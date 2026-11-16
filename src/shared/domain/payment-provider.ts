export const PAYMENT_PROVIDERS = ['MERCADOPAGO', 'STRIPE'] as const;

export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];
