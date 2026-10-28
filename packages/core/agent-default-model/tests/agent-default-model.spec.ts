/** Default model references remain live without a settings service. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import DefaultModel from '../src/index.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

it('reads complete selections from volatile config and clears omitted reasoning effort', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const live = await liveConfig(ctx, DefaultModel, { provider: 'p', model: 'm' })
  const consumer = ctx.agentDefaultModel
  await live.update({ provider: 'q', model: 'n', reasoningEffort: 'high' })
  expect(consumer.currentSelection()).toEqual({ provider: 'q', model: 'n', reasoningEffort: 'high' })
  await live.replace({ provider: 'p', model: 'm' })
  expect(consumer.currentSelection()).toEqual({ provider: 'p', model: 'm' })
  await consumer.saveSelection({ provider: 'unsaved', model: 'unsaved' })
  expect(consumer.currentSelection()).toEqual({ provider: 'p', model: 'm' })
})

it('reads the default routing mode from volatile config', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const live = await liveConfig(ctx, DefaultModel, { provider: 'p', model: 'm' })
  const consumer = ctx.agentDefaultModel
  expect(consumer.currentRoutingMode()).toBe('auto')
  await live.update({ routingMode: 'fixed' })
  expect(consumer.currentRoutingMode()).toBe('fixed')
  await live.replace({ provider: 'p', model: 'm' })
  expect(consumer.currentRoutingMode()).toBe('auto')
  // Without a configuration editor, saving the mode writes nothing.
  await consumer.saveRoutingMode('fixed')
  expect(consumer.currentRoutingMode()).toBe('auto')
})

it('persists complete selections through its owning profile entry', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ReasoningEffortId } = await import('@deepseek-ai/dsh-llm')
  const { ctx } = await configurationFixture({ hmr: false })
  await ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'next', reasoningEffort: ReasoningEffortId('high') })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'next', reasoningEffort: 'high' })
  await ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'final' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'final' })
  const standalone = new Context()
  onTestFinished(() => standalone.fiber.dispose())
  await standalone.plugin(DefaultModel, { provider: 'test', model: 'original' })
  await standalone.agentDefaultModel.saveSelection({ provider: 'test', model: 'ignored' })
  await standalone.agentDefaultModel.saveRoutingMode('fixed')
  expect(standalone.agentDefaultModel.currentSelection().model).toBe('original')
  expect(standalone.agentDefaultModel.currentRoutingMode()).toBe('auto')
})

it('persists the default routing mode through its owning profile entry', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ctx } = await configurationFixture({ hmr: false })
  const editor = ctx.configEditor
  const edit = vi.spyOn(editor, 'edit')
  await ctx.agentDefaultModel.saveRoutingMode('fixed')
  expect(edit).toHaveBeenCalledOnce()
  const change = edit.mock.calls[0]?.[1]
  expect(change?.({ provider: 'test', model: 'original' }, {})).toEqual({
    provider: 'test',
    model: 'original',
    routingMode: 'fixed',
  })
  expect(ctx.agentDefaultModel.currentRoutingMode()).toBe('fixed')
})

it('keeps the other keys of its entry when a selection is saved', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ctx } = await configurationFixture({ hmr: false })
  await ctx.agentDefaultModel.saveRoutingMode('fixed')
  await ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'next' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'next' })
  expect(ctx.agentDefaultModel.currentRoutingMode()).toBe('fixed')
})

it('continues saving the routing mode after a rejected write', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ctx } = await configurationFixture({ hmr: false })
  const editor = ctx.configEditor
  const edit = editor.edit.bind(editor)
  const intercepted = vi.spyOn(editor, 'edit').mockImplementationOnce(async () => {
    throw new Error('read-only document')
  }).mockImplementation(async (entry, change) => {
    await edit(entry, change)
  })
  const failed = expect(ctx.agentDefaultModel.saveRoutingMode('fixed')).rejects.toThrow('read-only document')
  const last = ctx.agentDefaultModel.saveRoutingMode('auto')
  onTestFinished(() => { intercepted.mockRestore() })
  await failed
  await last
  expect(ctx.agentDefaultModel.currentRoutingMode()).toBe('auto')
})

it('serializes overlapping saves and continues after a rejected write', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ctx } = await configurationFixture({ hmr: false })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const editor = ctx.configEditor
  const edit = editor.edit.bind(editor)
  const calls: string[] = []
  const intercepted = vi.spyOn(editor, 'edit').mockImplementationOnce(async () => {
    calls.push('rejected')
    entered.resolve(undefined)
    await release.promise
    throw new Error('read-only document')
  }).mockImplementation(async (entry, change) => {
    calls.push('saved')
    await edit(entry, change)
  })
  const first = ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'rejected' })
  const failed = expect(first).rejects.toThrow('read-only document')
  const lastSelection = { provider: 'test', model: 'final' }
  const last = ctx.agentDefaultModel.saveSelection(lastSelection)
  onTestFinished(async () => {
    release.resolve(undefined)
    await Promise.allSettled([failed, last])
    intercepted.mockRestore()
  })
  lastSelection.model = 'mutated'
  await entered.promise
  expect(calls).toEqual(['rejected'])
  release.resolve(undefined)
  await failed
  await last
  expect(calls).toEqual(['rejected', 'saved'])
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'final' })
})
