# DESIGN.md

This document defines product and UI design rules shared across platforms.

## Design Principles

- Preserve user intent and reduce cognitive load.
- Prefer clear hierarchy over visual decoration.
- Use consistent spacing, typography, color, iconography, and states.
- Empty, loading, success, and error states must be designed intentionally.
- Do not add UI elements that are not required by product spec or design source.

## Visual Parity Rule

When implementing from Figma, Stitch, screenshots, or design docs:

1. Match layout, spacing, typography, color, and state behavior.
2. Do not invent missing UI.
3. If implementation constraints require deviation, document it in the execution plan.
4. Add screenshots or manual verification notes when possible.

## Accessibility Baseline

- Interactive elements must have clear labels.
- Color must not be the only way to communicate status.
- Text should scale where the platform supports it.
- Tap/click targets should meet platform norms.
