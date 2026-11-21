import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { badRequest, unauthorized } from '../lib/errors';
import { authenticate, signToken } from '../auth/middleware';

const router = Router();

router.get('/demo-users', async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
      include: { trainingCentre: true },
    });
    res.json({
      users: users.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        district: user.district,
        trainingCentre: user.trainingCentre ? { id: user.trainingCentre.id, name: user.trainingCentre.name } : null,
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/demo-login', async (req, res, next) => {
  try {
    const parsed = z.object({ userId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) throw badRequest('userId is required');

    const user = await prisma.user.findUnique({
      where: { id: parsed.data.userId },
      include: { trainingCentre: true },
    });
    if (!user) throw unauthorized('Demo user not found');

    res.json({
      token: signToken(user),
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        district: user.district,
        trainingCentre: user.trainingCentre ? { id: user.trainingCentre.id, name: user.trainingCentre.name } : null,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/me', authenticate, async (req, res) => {
  res.json({ user: req.authUser });
});

export default router;
