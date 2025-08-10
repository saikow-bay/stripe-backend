import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import cors from 'cors';
import { supabaseAdmin } from './supabase.js';

const app = express();

app.use(cors({
  origin: (process.env.CORS_ORIGIN?.split(',') || ['http://localhost:5173']),
}));
app.use(express.json());

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get("/debug-cart", async (req, res) => {
    const { user_id } = req.query;
    try {
      const { data, error } = await supabase
        .from("cart")
        .select("*")
        .eq("user_id", user_id);
  
      if (error) {
        return res.status(500).json({ error: error.message });
      }
  
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  

app.post('/create-checkout-session', async (req, res) => {
  const { ownerType, ownerId, successUrl, cancelUrl } = req.body;

  const { data: cartItems } = await supabaseAdmin
    .from('cart')
    .select('quantity, size, product:product_id(name, price, image_urls)')
    .eq(ownerType === 'user' ? 'user_id' : 'session_id', ownerId);

  if (!cartItems || cartItems.length === 0) {
    return res.status(400).json({ error: 'Carrito vacío' });
  }

  const line_items = cartItems.map(item => ({
    quantity: item.quantity || 1,
    price_data: {
      currency: 'usd',
      product_data: {
        name: item.product.name,
        images: item.product.image_urls ? [item.product.image_urls[0]] : []
      },
      unit_amount: Math.round(item.product.price * 100),
    }
  }));

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items,
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { ownerType, ownerId }
  });

  res.json({ url: session.url });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de pagos en puerto ${PORT}`);
});
