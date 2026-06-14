

  it('channel_publish with omitted channelId defaults to home channel and is not rejected', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi' }]));
    const framework = await makeFramework();
    framework.pushEvent(incomingEvent({ channelId: 'slack:C11', text: 'help', mentioned: true }));
    await framework.runUntilIdle();
    const forkName = 'conversation-slack-C11-g1';
    assert.ok(framework.getAgent(forkName), 'fork should exist');

    const failures: Array<{ tool: string; error: string }> = [];
    framework.onTrace((e: TraceEvent) => {
      if (e.type === 'tool:failed') {
        failures.push({ tool: (e as { tool: string }).tool, error: (e as { error: string }).error });
      }
    });

    const fw = framework as unknown as {
      dispatchChannelToolCall(agentName: string, call: { id: string; name: string; input: Record<string, unknown> }): void;
    };

    // Omitted channelId — the fence should inject home (slack:C11) and NOT reject.
    fw.dispatchChannelToolCall(forkName, { id: 't1', name: 'channel_publish', input: { content: 'hello from home' } });

    assert.equal(failures.length, 0, 'home-default channel_publish must not be rejected by the fence');

    await framework.stop();
  });

  it('channel_publish to a foreign channelId is rejected', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi' }]));
    const framework = await makeFramework();
    framework.pushEvent(incomingEvent({ channelId: 'slack:C12', text: 'help', mentioned: true }));
    await framework.runUntilIdle();
    const forkName = 'conversation-slack-C12-g1';
    assert.ok(framework.getAgent(forkName), 'fork should exist');

    const failures: Array<{ tool: string; error: string }> = [];
    framework.onTrace((e: TraceEvent) => {
      if (e.type === 'tool:failed') {
        failures.push({ tool: (e as { tool: string }).tool, error: (e as { error: string }).error });
      }
    });

    const fw = framework as unknown as {
      dispatchChannelToolCall(agentName: string, call: { id: string; name: string; input: Record<string, unknown> }): void;
    };

    // Foreign channelId — the fence must reject this publish.
    fw.dispatchChannelToolCall(forkName, { id: 't2', name: 'channel_publish', input: { channelId: 'slack:C99', content: 'hello foreign' } });

    assert.equal(failures.length, 1, 'foreign channel_publish should be rejected by the fence');
    assert.ok(failures[0]!.error.includes('slack:C99'), 'rejection error should reference the foreign channel');

    await framework.stop();
  });
});
