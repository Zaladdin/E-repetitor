'use client';

import { createContext } from 'react';

// Preserve local form state while private content is hidden during identity verification.
export const AccountSessionSuspendedContext = createContext(false);
