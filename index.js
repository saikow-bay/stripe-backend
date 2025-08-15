// index.js
import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import cors from 'cors';
import { supabaseAdmin } from './supabase.js';

const app = express();

// CORS
app.use(
  cors({
    origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:5173'],
  })
);

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
      `);

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
          ? Math.round(priceMXN * 100) // MXN → centavos
          : Math.round((priceMXN / USD_MXN_RATE) * 100); // a USD con tipo de cambio

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
      // importante: session_id en el success para confirmarlo después
      success_url:
        successUrl ||
        `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || `${process.env.FRONTEND_URL}/cart`,
      metadata: { ownerType, ownerId, currency: curr },
      shipping_address_collection: { allowed_countries: ['MX', 'US'] },
      phone_number_collection: { enabled: true }, // <-- NUEVO: pedir teléfono
    });

    res.json({ url: session.url, id: session.id });
  } catch (e) {
    console.error('create-checkout-session error:', e);
    res.status(500).json({ error: 'internal' });
  }
});

/**
 * Confirmar orden SIN webhook (idempotente):
 * - recibe session_id desde /success
 * - verifica con Stripe
 * - si no existe orden para esa sesión, la crea y vacía el carrito
 * - si ya existía, responde ok sin duplicar
 * - guarda customer/shipping/ship_to para saber a dónde enviar
 */
app.post('/confirm-order', async (req, res) => {
  try {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ error: 'session_id requerido' });

    // 1) Trae la sesión real de Stripe (ya incluye customer y shipping)
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['line_items'],
    });

    // 2) Debe estar pagada
    if (session.payment_status !== 'paid') {
      return res
        .status(400)
        .json({ error: 'La sesión no está pagada', status: session.payment_status });
    }

    const ownerType = session.metadata?.ownerType; // "user" | "session"
    const ownerId = session.metadata?.ownerId;
    const currency = (session.metadata?.currency || session.currency || 'mxn').toLowerCase();

    if (!ownerType || !ownerId) {
      return res.status(400).json({ error: 'Faltan metadatos de owner en la sesión' });
    }

    // 3) Idempotencia: ¿ya existe una orden para esta sesión?
    const existing = await supabaseAdmin
      .from('orders')
      .select('id')
      .eq('stripe_session_id', session.id)
      .maybeSingle();

    if (existing.data) {
      return res.json({ ok: true, alreadyProcessed: true, orderId: existing.data.id });
    }

    // 4) Leer carrito actual del dueño
    const base = supabaseAdmin
      .from('cart')
      .select('quantity, size, product:product_id(id, name, brand, price, image_urls)');

    const { data: cartItems, error } =
      ownerType === 'user' ? await base.eq('user_id', ownerId) : await base.eq('session_id', ownerId);

    if (error) return res.status(500).json({ error: error.message });

    // 5) Total en MXN base
    const amountMXN = (cartItems || []).reduce(
      (acc, it) => acc + Number(it.product?.price || 0) * (it.quantity || 1),
      0
    );

    // 6) Armar datos de cliente/envío desde Stripe
    const customer = session.customer_details || null;  // {name,email,phone,address?}
    const shipping = session.shipping_details || null;  // {name,address{...}}

    const address = shipping?.address || customer?.address || {};
    const shipToText = [
      (shipping?.name || customer?.name || '').trim(),
      [address.line1, address.line2].filter(Boolean).join(' '),
      [address.postal_code, address.city].filter(Boolean).join(' '),
      [address.state, address.country].filter(Boolean).join(' ')
    ]
      .filter(Boolean)
      .join(', ');

    // 7) Crear orden (si hay carrera, el índice único nos protege)
    const { data: orderData, error: orderErr } = await supabaseAdmin
      .from('orders')
      .insert([
        {
          user_id: ownerType === 'user' ? ownerId : null,
          session_id: ownerType === 'session' ? ownerId : null,
          stripe_session_id: session.id,
          currency,
          amount: amountMXN,
          status: 'paid',
          customer,            // <-- NUEVO
          shipping,            // <-- NUEVO
          ship_to: shipToText, // <-- NUEVO (texto plano)
          items: (cartItems || []).map((c) => ({
            product_id: c.product?.id,
            name: c.product?.name,
            brand: c.product?.brand,
            price: c.product?.price,
            quantity: c.quantity,
            size: c.size,
            image: c.product?.image_urls?.[0] || null,
          })),
        },
      ])
      .select('id')
      .single();

    if (orderErr) {
      const msg = (orderErr.message || '').toLowerCase();
      if (msg.includes('duplicate key') || msg.includes('uniq') || msg.includes('unique')) {
        return res.json({ ok: true, alreadyProcessed: true });
      }
      return res.status(500).json({ error: orderErr.message });
    }

    // 8) Vaciar carrito (solo si acabamos de crear la orden)
    const clear = supabaseAdmin.from('cart').delete();
    if (ownerType === 'user') await clear.eq('user_id', ownerId);
    else await clear.eq('session_id', ownerId);

    return res.json({ ok: true, orderCreated: true, orderId: orderData.id });
  } catch (e) {
    console.error('confirm-order error:', e);
    return res.status(500).json({ error: 'internal' });
  }
});

// Arranque
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de pagos en puerto ${PORT}`);
});
