# Experiment Plan — KL-NO

**Date**: 2025-07-15
**Related proposal**: `refine-logs/FINAL_PROPOSAL.md`

---

## Claim-Driven Experiment Roadmap

### Primary Claim
> KL-NO maintains bounded prediction error (RMSE < 2× one-step error) for rollouts ≥ 1000 time steps on dissipative PDE benchmarks, while matching FNO/KNO accuracy on short horizons (T ≤ 50).

---

## Experiment Blocks

### Block A: Core Benchmark Suite (Must-Run, Est. 12 GPU hours)

| Experiment | PDE | Resolution | Rollout T | Metric | GPU hrs |
|-----------|-----|------------|-----------|--------|---------|
| A1 | Burgers' (ν=0.01) | 1024 | 2000 | RMSE(t), E(k) | 2 |
| A2 | Burgers' (ν=0.001) | 1024 | 2000 | RMSE(t), E(k) | 2 |
| A3 | Navier-Stokes 2D (Re=100) | 64×64 | 500 | RMSE(t), vorticity corr | 4 |
| A4 | Allen-Cahn (ε=0.01) | 256 | 500 | RMSE(t) | 2 |
| A5 | Reaction-Diffusion (λ=0.1) | 256 | 500 | RMSE(t) | 2 |

### Block B: Baselines (Must-Run, Est. 8 GPU hours)

| Experiment | Method | PDE | GPU hrs |
|-----------|--------|-----|---------|
| B1 | FNO (standard) | A1–A5 | 2 |
| B2 | KNO (no stability) | A1–A5 | 2 |
| B3 | FNO + SpectralNorm | A1–A5 | 1 |
| B4 | FNO + NoiseInjection | A1–A5 | 1 |
| B5 | FNO + EMA | A1–A5 | 1 |
| B6 | RNO (recurrent training) | A1, A3 | 1 |

### Block C: Ablations (Must-Run, Est. 6 GPU hours)

| Experiment | Variant | GPU hrs |
|-----------|---------|---------|
| C1 | KL-NO full (our method) | — (Block A) |
| C2 | KL-NO no Lyapunov loss (contractive param only) | 2 |
| C3 | KL-NO no contractive param (Lyapunov loss only) | 2 |
| C4 | KL-NO with MLP encoder (not FNO encoder) | 2 |

### Block D: Sensitivity Analysis (Should-Run, Est. 4 GPU hours)

| Experiment | Sweep | GPU hrs |
|-----------|-------|---------|
| D1 | ε ∈ {0.01, 0.05, 0.1, 0.2, 0.5} | 2 |
| D2 | α ∈ {0.9, 0.95, 0.99, 0.999} | 1 |
| D3 | Latent dim d ∈ {32, 64, 128, 256} | 1 |

### Block E: Energy Spectrum Analysis (Must-Run, Est. 2 GPU hours)

| Experiment | Analysis | GPU hrs |
|-----------|----------|---------|
| E1 | E(k) comparison: KL-NO vs GT vs FNO vs KNO at T=10, 100, 500 | 1 |
| E2 | Small-scale energy decay check (verify no artificial damping) | 1 |

---

## Run Order

```
Phase 1 (primary signal): A1, B1, B2          → confirm pilot holds
Phase 2 (ablation):      C2, C3, C4            → identify active ingredients
Phase 3 (full sweep):    A2–A5, B3–B6          → multi-PDE validation
Phase 4 (sensitivity):   D1–D3                 → robustness
Phase 5 (analysis):      E1, E2                → spectrum check
```

---

## Budget Summary

| Category | GPU Hours |
|----------|-----------|
| Must-run (A+B+C+E) | 28 |
| Should-run (D) | 4 |
| **Total** | **32** |

Within MAX_TOTAL_GPU_HOURS = 8 budget, run: A1, A3, B1–B2, C2–C3, E1. This subset (7.5 GPU hrs) validates the core claim and ablation.

---

## Success Criteria

- **Strong positive**: KL-NO RMSE at T=1000 < 2× FNO RMSE at T=1000, AND energy spectrum E(k) match at T=500 within 10% across all k
- **Weak positive**: Above holds for Burgers' but not Navier-Stokes
- **Negative**: KL-NO RMSE comparable to FNO+SpectralNorm at T>500, OR severe small-scale energy under-prediction

---

## Implementation Notes

- Use `neuraloperator` library (Anandkumar lab) as FNO backbone
- Implement contractive spectral layer as a custom `torch.nn.Module`
- Two-phase training: Phase 1 (70% epochs, λ_lyap=0), Phase 2 (30% epochs, λ_lyap linear warmup 0→0.1)
- All experiments on single A100 (40GB)
