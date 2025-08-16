// src/auth/admin.ts
import { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";

export function ensureAdmin(req: Request, res: Response, next: NextFunction) {
  const { sessionClaims } = getAuth(req);

  // Clerk do JWT vkladá tvoje publicMetadata
  const role = sessionClaims?.publicMetadata?.role;

  if (role !== "admin") {
    return res.status(403).json({ success: false, message: "Admins only" });
  }

  next();
}
