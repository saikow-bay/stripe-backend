// index.js
import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import cors from 'cors';
import { supabaseAdmin } from './supabase.js';

const app = express();

// CORS
app.use(cors({
  origin: (process.env.CORS_ORIGIN?.split(',') || ['http://localhost:5173']),
}));

app.use(express.json());

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

// Salud
app.get('/health', (_req, res) => res.json({ ok: true }));

// DEBUG carrito (por user o por session)
app.get('/debug-cart', async (req, res) => {
  try {
    const { user_id, session_id } = req.query;
    if (!user_id && !session_id) {
      return res.status(400).json({ error: 'Falta user_id o session_id' });
    }

    const base = supabaseAdmin.from('cart').select('*');
    const { data, error } = user_id
      ? await base.eq('user_id', user_id)
      : await base.eq('session_id', session_id);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Checkout con 2 monedas (MXN y USD) SIN usar Products/Prices de Stripe.
 * products.price en tu DB se toma como PRECIO BASE EN MXN.
 * Si pides USD, convierte usando USD_MXN_RATE (variable de entorno).
 */
const ALLOWED_CURRENCIES = new Set(['mxn', 'usd']);
const USD_MXN_RATE = Number(process.env.USD_MXN_RATE || '17.0'); // 1 USD = 17 MXN (ajústalo en Railway)

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { ownerType, ownerId, successUrl, cancelUrl, currency } = req.body;

    if (!ownerType || !ownerId) {
      return res.status(400).json({ error: 'ownerType y ownerId son requeridos' });
    }

    const curr = (currency || 'mxn').toLowerCase();
    if (!ALLOWED_CURRENCIES.has(curr)) {
      return res.status(400).json({ error: 'Moneda no permitida (mxn, usd)' });
    }

    // Traer carrito con datos del producto (price = MXN base)
    const base = supabaseAdmin
      .from('cart')
      .select(`
        quantity, size,
        product:product_id ( id, name, brand, price, image_urls )
      )`);

    const { data: cartItems, error } =
      ownerType === 'user'
        ? await base.eq('user_id', ownerId)
        : await base.eq('session_id', ownerId);

    if (error) return res.status(500).json({ error: error.message });
    if (!cartItems?.length) return res.status(400).json({ error: 'Cart vacío' });

    // Construir line_items dinámicos con price_data (sin Stripe Products)
    const line_items = cartItems.map((item) => {
      const p = item.product;
      const priceMXN = Number(p?.price || 0); // MXN base en tu DB
      if (!priceMXN) throw new Error(`Producto ${p?.id} sin price en MXN`);

      const unitAmount =
        curr === 'mxn'
          ? Math.round(priceMXN * 100)                       // MXN → centavos
          : Math.round((priceMXN / USD_MXN_RATE) * 100);     // a USD con tipo de cambio

      return {
        quantity: item.quantity || 1,
        price_data: {
          currency: curr, // 'mxn' o 'usd'
          product_data: {
            name: p?.name || 'Product',
            description: [p?.brand, item.size].filter(Boolean).join(' - '),
            images: p?.image_urls?.length ? [p.image_urls[0]] : undefined,
          },
          unit_amount: unitAmount,
        },
      };
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items,
      success_url: successUrl || `${process.env.FRONTEND_URL}/success`,
      cancel_url: cancelUrl || `${process.env.FRONTEND_URL}/cart`,
      metadata: { ownerType, ownerId, currency: curr },
      shipping_address_collection: { allowed_countries: ['MX', 'US'] },
    });

    res.json({ url: session.url, id: session.id });
  } catch (e) {
    console.error('create-checkout-session error:', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Arranque
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de pagos en puerto ${PORT}`);
});
