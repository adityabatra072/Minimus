import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { getToolRegistry } from '../tools';
import { useToolStore, type CustomHttpTool, type McpServerConfig } from '../stores/toolStore';
import { mcpStatus, syncToolPlatform } from '../services/toolPlatform';
import { verbFor } from '../services/humanize';
import { font, radius, space, usePalette } from '../theme';
import { Button, Chip, Field, Header, Label, Row, Screen, Segmented, Toggle } from '../ui/primitives';

/**
 * Tools — the agent's capability surface, user-controlled: every built-in
 * tool with a switch, plus your own HTTP tools and MCP servers. Anything you
 * add asks for approval every time it runs.
 */

const GROUP_LABEL: Record<string, string> = {
  device: 'Phone',
  schedule: 'Calendar and time',
  core: 'Memory and phrases',
  web: 'Web',
  comms: 'Messages and calls',
  music: 'Music',
  vision: 'Photos',
};

export default function ToolsScreen({ onClose }: { onClose: () => void }): React.JSX.Element {
  const p = usePalette();
  const disabled = useToolStore((s) => s.disabled);
  const setDisabled = useToolStore((s) => s.setDisabled);
  const custom = useToolStore((s) => s.custom);
  const addCustom = useToolStore((s) => s.addCustom);
  const removeCustom = useToolStore((s) => s.removeCustom);
  const mcpServers = useToolStore((s) => s.mcpServers);
  const addMcpServer = useToolStore((s) => s.addMcpServer);
  const removeMcpServer = useToolStore((s) => s.removeMcpServer);
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [showMcpForm, setShowMcpForm] = useState(false);
  const [, forceRender] = useState(0);

  const builtins = useMemo(() => {
    const byGroup = new Map<string, { name: string; description: string; approval: boolean }[]>();
    const registry = getToolRegistry();
    for (const t of registry.list()) {
      if (t.group === 'custom' || t.group === 'mcp') continue;
      const group = t.group ?? 'core';
      byGroup.set(group, [
        ...(byGroup.get(group) ?? []),
        { name: t.name, description: t.description, approval: registry.requiresApproval({ id: 'x', name: t.name, arguments: {} }) },
      ]);
    }
    const order = ['device', 'schedule', 'core', 'web', 'comms', 'music', 'vision'];
    return [...byGroup.entries()].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
  }, []);

  const resync = () => void syncToolPlatform(getToolRegistry()).then(() => forceRender((n) => n + 1));
  const enabledCount = builtins.reduce((n, [, ts]) => n + ts.filter((t) => !disabled.includes(t.name)).length, 0);
  const totalCount = builtins.reduce((n, [, ts]) => n + ts.length, 0);

  return (
    <Screen>
      <Header title="Tools" eyebrow={`${enabledCount} of ${totalCount} built-in on`} onClose={onClose} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={[styles.blurb, { color: p.ink2 }]}>
          Everything the agent can touch, and the switch for each. Tools you add need your approval every time they run.
        </Text>

        {builtins.map(([group, tools]) => (
          <View key={group} style={styles.group}>
            <Label style={{ marginLeft: space(1) }}>{GROUP_LABEL[group] ?? group}</Label>
            <View>
              {tools.map((t, i) => (
                <Row
                  key={t.name}
                  title={humanName(t.name)}
                  subtitle={`${t.description}${t.approval ? ' · asks first' : ''}`}
                  right={<Toggle value={!disabled.includes(t.name)} onChange={(on) => setDisabled(t.name, !on)} />}
                  first={i === 0}
                  last={i === tools.length - 1}
                />
              ))}
            </View>
          </View>
        ))}

        <View style={styles.group}>
          <Label style={{ marginLeft: space(1) }}>MCP servers</Label>
          <Text style={[styles.hint, { color: p.ink3 }]}>Connect any streamable-HTTP MCP server. Its tools appear to the agent, each behind an approval card.</Text>
          {mcpServers.map((s) => {
            const status = mcpStatus.get(s.name);
            return (
              <View key={s.name} style={[styles.card, { backgroundColor: p.surface, borderColor: p.line }]}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[styles.cardTitle, { color: p.ink }]}>{s.name}</Text>
                  <Text style={[styles.cardMeta, { color: p.ink3 }]} numberOfLines={1}>
                    {s.url}
                  </Text>
                  <Text style={[styles.cardMeta, { color: status?.state === 'error' ? p.danger : status ? p.ok : p.ink3 }]}>
                    {status ? (status.state === 'ok' ? `connected · ${status.tools} tools` : `error: ${status.detail.slice(0, 80)}`) : 'not connected yet'}
                  </Text>
                </View>
                <Button label="Remove" kind="ghost" small onPress={() => { removeMcpServer(s.name); resync(); }} />
              </View>
            );
          })}
          {showMcpForm ? (
            <McpForm onAdd={(server) => { addMcpServer(server); setShowMcpForm(false); resync(); }} onCancel={() => setShowMcpForm(false)} />
          ) : (
            <View style={styles.actions}>
              <Chip label="+ Add MCP server" onPress={() => setShowMcpForm(true)} />
              {mcpServers.length > 0 ? <Chip label="Reconnect" onPress={resync} /> : null}
            </View>
          )}
        </View>

        <View style={styles.group}>
          <Label style={{ marginLeft: space(1) }}>Your HTTP tools</Label>
          <Text style={[styles.hint, { color: p.ink3 }]}>Give the agent any API: a name, what it does, a URL and its parameters.</Text>
          {custom.map((t) => (
            <View key={t.name} style={[styles.card, { backgroundColor: p.surface, borderColor: p.line }]}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[styles.cardTitle, { color: p.ink }]}>{t.name}</Text>
                <Text style={[styles.cardMeta, { color: p.ink3 }]} numberOfLines={2}>
                  {t.method} {t.url}
                </Text>
              </View>
              <Button label="Remove" kind="ghost" small onPress={() => { removeCustom(t.name); resync(); }} />
            </View>
          ))}
          {showCustomForm ? (
            <CustomForm onAdd={(tool) => { addCustom(tool); setShowCustomForm(false); resync(); }} onCancel={() => setShowCustomForm(false)} />
          ) : (
            <View style={styles.actions}>
              <Chip label="+ Add HTTP tool" onPress={() => setShowCustomForm(true)} />
            </View>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

function humanName(tool: string): string {
  const v = verbFor({ id: 'x', name: tool, arguments: {} });
  // verbFor phrases an action in progress ("Turning flashlight on"); the
  // list wants the noun. Fall back to the snake_case name spaced out.
  return v && !/…/.test(v) && v !== tool.replace(/_/g, ' ') ? v.replace(/^(Turning|Setting|Reading|Opening|Copying|Searching|Checking|Adding|Starting|Scheduling|Posting|Playing|Drafting|Calling|Running|Saving) /, '') : tool.replace(/_/g, ' ');
}

function McpForm({ onAdd, onCancel }: { onAdd: (s: McpServerConfig) => void; onCancel: () => void }): React.JSX.Element {
  const p = usePalette();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [auth, setAuth] = useState('');
  return (
    <View style={[styles.form, { backgroundColor: p.surface, borderColor: p.ink }]}>
      <Field label="Name" value={name} onChangeText={setName} placeholder="slack" />
      <Field label="URL" value={url} onChangeText={setUrl} placeholder="https://mcp.example.com/mcp" keyboardType="url" />
      <Field label='Auth (optional): "Bearer KEY" or "header-name: KEY"' value={auth} onChangeText={setAuth} placeholder="x-api-key: ak_…" secureTextEntry />
      <View style={styles.formButtons}>
        <Button label="Cancel" kind="ghost" small onPress={onCancel} />
        <Button label="Connect" small disabled={!(name.trim() && url.trim().startsWith('http'))} onPress={() => onAdd({ name: name.trim(), url: url.trim(), auth: auth.trim() })} />
      </View>
    </View>
  );
}

function CustomForm({ onAdd, onCancel }: { onAdd: (t: CustomHttpTool) => void; onCancel: () => void }): React.JSX.Element {
  const p = usePalette();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [url, setUrl] = useState('');
  const [method, setMethod] = useState<'GET' | 'POST'>('GET');
  const [headersJson, setHeadersJson] = useState('');
  const [params, setParams] = useState('');
  return (
    <View style={[styles.form, { backgroundColor: p.surface, borderColor: p.ink }]}>
      <Field label="Tool name (snake_case)" value={name} onChangeText={setName} placeholder="check_weather" />
      <Field label="Description (the model reads this)" value={description} onChangeText={setDescription} placeholder="Get the weather for a city" autoCapitalize="sentences" />
      <Field label="URL" value={url} onChangeText={setUrl} placeholder="https://api.example.com/weather" keyboardType="url" />
      <Segmented options={[{ value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' }]} value={method} onChange={setMethod} />
      <Field label='Parameters ("name: description, name: description")' value={params} onChangeText={setParams} placeholder="city: the city to check" />
      <Field label="Headers JSON (optional)" value={headersJson} onChangeText={setHeadersJson} placeholder='{"x-api-key": "…"}' />
      <View style={styles.formButtons}>
        <Button label="Cancel" kind="ghost" small onPress={onCancel} />
        <Button
          label="Save"
          small
          disabled={!(name.trim() && description.trim() && url.trim().startsWith('http'))}
          onPress={() => onAdd({ name: name.trim(), description: description.trim(), url: url.trim(), method, headersJson: headersJson.trim(), params: params.trim() })}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: space(4), paddingBottom: space(12), gap: space(6) },
  blurb: { fontSize: 14, lineHeight: 20 },
  group: { gap: space(2) },
  hint: { fontSize: 12, lineHeight: 17, marginLeft: space(1) },
  card: { flexDirection: 'row', alignItems: 'center', gap: space(3), borderWidth: 1, borderRadius: radius.lg, padding: space(4) },
  cardTitle: { fontSize: 15, fontWeight: '600' },
  cardMeta: { fontSize: 11, fontFamily: font.mono },
  actions: { flexDirection: 'row', gap: space(2), flexWrap: 'wrap' },
  form: { borderWidth: 1, borderRadius: radius.lg, padding: space(4), gap: space(3) },
  formButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: space(2), marginTop: space(1) },
});
