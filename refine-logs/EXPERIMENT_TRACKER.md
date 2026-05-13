# Experiment Tracker — KL-NO

**Created**: 2025-07-15
**Plan**: `refine-logs/EXPERIMENT_PLAN.md`

---

| # | Experiment | Status | Date Run | RMSE (T=100) | RMSE (T=500) | RMSE (T=1000) | Notes |
|---|-----------|--------|----------|-------------|-------------|-------------|-------|
| A1 | Burgers' ν=0.01 | ⬜ pending | — | — | — | — | Core signal |
| A2 | Burgers' ν=0.001 | ⬜ pending | — | — | — | — | |
| A3 | Navier-Stokes 2D | ⬜ pending | — | — | — | — | Key generalization test |
| A4 | Allen-Cahn | ⬜ pending | — | — | — | — | |
| A5 | Reaction-Diffusion | ⬜ pending | — | — | — | — | |
| B1 | FNO baseline | ⬜ pending | — | — | — | — | |
| B2 | KNO baseline | ⬜ pending | — | — | — | — | |
| B3 | FNO+SpectralNorm | ⬜ pending | — | — | — | — | |
| B4 | FNO+Noise | ⬜ pending | — | — | — | — | |
| B5 | FNO+EMA | ⬜ pending | — | — | — | — | |
| B6 | RNO | ⬜ pending | — | — | — | — | |
| C1 | KL-NO full | ⬜ pending | — | — | — | — | = A1 |
| C2 | No Lyapunov loss | ⬜ pending | — | — | — | — | |
| C3 | No contractive param | ⬜ pending | — | — | — | — | |
| C4 | MLP encoder | ⬜ pending | — | — | — | — | |
| D1 | ε sweep | ⬜ pending | — | — | — | — | |
| D2 | α sweep | ⬜ pending | — | — | — | — | |
| D3 | d sweep | ⬜ pending | — | — | — | — | |
| E1 | E(k) comparison | ⬜ pending | — | — | — | — | |
| E2 | Small-scale decay | ⬜ pending | — | — | — | — | |

---

## Pilot Summary (Pre-plan)

| Variant | T=100 | T=500 | T=2000 | Bounded? |
|---------|-------|-------|--------|----------|
| FNO | 0.018 | diverged | diverged | No |
| KNO | 0.015 | 0.032 | 0.089 | No (growing) |
| KL-NO | 0.015 | 0.026 | 0.027 | **Yes** |

---

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2025-07-15 | Two-phase training | R2 reviewer feedback: avoid Lyapunov collapsing latent before observables are learned |
| 2025-07-15 | FNO encoder over MLP | R1→R2 refinement: resolution-invariance required for multi-resolution evaluation |
| 2025-07-15 | Low-rank L parametrization | R1→R2: full rank unnecessarily expensive, r=8 sufficient |
| 2025-07-15 | α=0.99 fixed | R2→R3: learned α unstable, decays to 0 |
