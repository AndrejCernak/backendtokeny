// auth/admin.ts (nový súbor)
import { Request, Response, NextFunction } from "express";
import { getUserIdFromAuthHeader } from "../server"; // ak máš helper inde, uprav cestu

export async function ensureAdmin(req: Request, res: Response, next: NextFunction) {
  const userId = await getUserIdFromAuthHeader(req);
  if (!userId) return res.status(401).json({ success: false, message: "Unauthenticated" });
  if (userId !== process.env.ADMIN_ID) return res.status(403).json({ success: false, message: "Admins only" });
  (req as any).authUserId = userId;
  next();
}
