# Plugin runtime domain

## Canonical transcript

The host-neutral ordered messages and blocks sent by an agent Adapter. Message
and block identities are stable for the duration of one context flight; hosts
may additionally provide durable identities across flights.

## Context plan

The Runtime's complete decision for one provider request: retained messages,
block mutations, injection slots, token accounting, and optional reverse
callbacks. An Adapter materializes this plan without choosing policy.

## Tag

A monotonic session-local `§N§` identity for a message, file, or composite tool
invocation `(owner message, call id)`. Tags remain resolvable after reduction.

## Scheduler

The Runtime Module that converts token pressure, cache age, tool-arc state, and
configured budgets into a context pass and working-window target.

## Storage

The Runtime-owned persistence Module for session state and project memory.
Hosts select a runtime transport; they never open, migrate, or query storage.

## Memory

Validated durable project knowledge with exact deduplication, hybrid recall,
visibility filtering, mutation, and budgeted rendering.

## Injection

The ordered preparation of Historian compartments, recalled memory, automatic
triggers, Sidekick augmentation, and tag mutations before compose.

## Agent Adapter

Host-specific message codec, hook registration, usage/context facts, native
tool registration, and auxiliary-LLM execution. It must not implement tagging,
scheduling, persistence, recall, or injection policy.
