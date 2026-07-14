import express from 'express';
import { ObjectId } from 'mongodb';
import { fromNodeHeaders } from 'better-auth/node';
import { auth, mongo } from './auth.js';

const shaders = mongo.collection('shaders');
const likes = mongo.collection('likes');

async function getSession(req) {
  return auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
}

async function requireSession(req, res, next) {
  const session = await getSession(req);
  if (!session) return res.status(401).json({ error: 'Not signed in' });
  req.session = session;
  next();
}

function toId(id) {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}

function serialize(doc) {
  return {
    id: doc._id.toString(),
    title: doc.title,
    glslSource: doc.glslSource,
    params: doc.params ?? {},
    ownerId: doc.ownerId,
    ownerName: doc.ownerName,
    remixOfId: doc.remixOfId ?? null,
    public: doc.public !== false,
    likeCount: doc.likeCount ?? 0,
    createdAt: doc.createdAt,
  };
}

export const shaderRoutes = express.Router();

// Save the current shader to the signed-in user's profile.
shaderRoutes.post('/shaders', requireSession, async (req, res) => {
  const { title, glslSource, params, remixOfId, public: isPublic } = req.body;
  if (!title?.trim() || !glslSource?.trim()) {
    return res.status(400).json({ error: 'title and glslSource are required' });
  }

  const doc = {
    title: title.trim().slice(0, 120),
    glslSource,
    params: params ?? {},
    ownerId: req.session.user.id,
    ownerName: req.session.user.displayUsername || req.session.user.username || req.session.user.name,
    remixOfId: remixOfId ? String(remixOfId) : null,
    public: isPublic !== false,
    likeCount: 0,
    createdAt: new Date(),
  };
  const result = await shaders.insertOne(doc);
  res.json(serialize({ ...doc, _id: result.insertedId }));
});

// Owner-only delete.
shaderRoutes.delete('/shaders/:id', requireSession, async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });

  const doc = await shaders.findOne({ _id: id });
  if (!doc) return res.status(404).json({ error: 'not found' });
  if (doc.ownerId !== req.session.user.id) {
    return res.status(403).json({ error: 'not the owner' });
  }
  await shaders.deleteOne({ _id: id });
  await likes.deleteMany({ shaderId: req.params.id });
  res.json({ ok: true });
});

// Single shader (used for the /s/:id permalink + remix source).
shaderRoutes.get('/shaders/:id', async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  const doc = await shaders.findOne({ _id: id });
  if (!doc) return res.status(404).json({ error: 'not found' });
  res.json(serialize(doc));
});

// A given user's public profile feed.
shaderRoutes.get('/users/:handle/shaders', async (req, res) => {
  const docs = await shaders
    .find({ ownerName: req.params.handle, public: true })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();
  res.json(docs.map(serialize));
});

// Global community feed for the showcase page.
shaderRoutes.get('/shaders/feed/recent', async (req, res) => {
  const docs = await shaders
    .find({ public: true })
    .sort({ createdAt: -1 })
    .limit(60)
    .toArray();
  res.json(docs.map(serialize));
});

// Like / unlike toggle, one like per user per shader.
shaderRoutes.post('/shaders/:id/like', requireSession, async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });

  const existing = await likes.findOne({ shaderId: req.params.id, userId: req.session.user.id });
  if (existing) {
    await likes.deleteOne({ _id: existing._id });
    await shaders.updateOne({ _id: id }, { $inc: { likeCount: -1 } });
    return res.json({ liked: false });
  }
  await likes.insertOne({ shaderId: req.params.id, userId: req.session.user.id, createdAt: new Date() });
  await shaders.updateOne({ _id: id }, { $inc: { likeCount: 1 } });
  res.json({ liked: true });
});
