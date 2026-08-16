import React, { useMemo, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { getToolRegistry } from '../tools';
import { useToolStore, type CustomHttpTool, type McpServerConfig } from '../stores/toolStore';
import { mcpStatus, syncToolPlatform } from '../services/toolPlatform';
import { color, font, radius, space } from '../theme';

/**
 * The agent's capability surface, user-controlled: every registered tool
 * visible and toggleable, plus user-defined HTTP tools and MCP servers.
 * "Claude Code for phone" means the user decides what the agent can touch.
 */

export default function ToolsScreen({ onClose }: { onClose: () => void }): React.JSX.Element {
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
    const byGroup = new Map<string, { name: string; description: string }[]>();
    for (const t of getToolRegistry().list()) {
      if (t.group === 'custom' || t.group === 'mcp') continue;
      const group = t.group ?? 'core';
      byGroup.set(group, [...(byGroup.get(group) ?? []), { name: t.name, description: t.description }]);
    }
    return [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, []);

  const resync = () => {
    void syncToolPlatform(getToolRegistry()).then(() => forceRender((n) => n + 1));
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Tools</Text>
        <TouchableOpacity onPress={onClose} hitSlop={12}>
          <Text style={styles.close}>Done</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.blurb}>
          Everything the agent can do, and the switch for each. Tools you add here need your
          approval every time they run.
        </Text>

        <Text style={styles.sectionLabel}>mcp servers</Text>
        {mcpServers.length === 0 ? (
          <Text style={styles.rowHint}>No MCP servers added yet.</Text>
        ) : null}
        {mcpServers.map((s) => {
          const status = mcpStatus.get(s.name);
          return (
            <View key={s.name} style={styles.row}>
              <View style={styles.rowMain}>
                <Text style={styles.rowTitle}>{s.name}</Text>
                <Text style={styles.rowHint} numberOfLines={1}>
                  {s.url}
                </Text>
                <Text style={[styles.rowMeta, status?.state === 'error' && styles.err]}>
                  {status
                    ? status.state === 'ok'
                      ? `connected · ${status.tools} tools`
                      : `error: ${status.detail.slice(0, 80)}`
                    : 'not connected yet'}
                </Text>
              </View>
              <TouchableOpacity
                hitSlop={10}
                onPress={() => removeMcpServer(s.name)}
                accessibilityRole="button"
                accessibilityLabel="Delete MCP server"
              >
                <Text style={styles.delete}>✕</Text>
              </TouchableOpacity>
            </View>
          );
        })}
        {showMcpForm ? (
          <McpForm
            onAdd={(server) => {
              addMcpServer(server);
              setShowMcpForm(false);
              resync();
            }}
            onCancel={() => setShowMcpForm(false)}
          />
        ) : (
          <View style={styles.actionsRow}>
            <TouchableOpacity style={styles.addBtn} onPress={() => setShowMcpForm(true)}>
              <Text style={styles.addBtnText}>＋ add MCP server</Text>
            </TouchableOpacity>
            {mcpServers.length > 0 ? (
              <TouchableOpacity style={styles.addBtn} onPress={resync}>
                <Text style={styles.addBtnText}>reconnect</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        )}

        <Text style={styles.sectionLabel}>custom tools</Text>
        {custom.length === 0 ? <Text style={styles.rowHint}>No custom tools yet.</Text> : null}
        {custom.map((t) => (
          <View key={t.name} style={styles.row}>
            <View style={styles.rowMain}>
              <Text style={styles.rowTitle}>{t.name}</Text>
              <Text style={styles.rowHint} numberOfLines={2}>
                {t.method} {t.url}
              </Text>
            </View>
            <TouchableOpacity
              hitSlop={10}
              onPress={() => {
                removeCustom(t.name);
                resync();
              }}
              accessibilityRole="button"
              accessibilityLabel="Delete custom tool"
            >
              <Text style={styles.delete}>✕</Text>
            </TouchableOpacity>
          </View>
        ))}
        {showCustomForm ? (
          <CustomForm
            onAdd={(tool) => {
              addCustom(tool);
              setShowCustomForm(false);
              resync();
            }}
            onCancel={() => setShowCustomForm(false)}
          />
        ) : (
          <TouchableOpacity style={styles.addBtn} onPress={() => setShowCustomForm(true)}>
            <Text style={styles.addBtnText}>＋ add HTTP tool</Text>
          </TouchableOpacity>
        )}

        <Text style={styles.sectionLabel}>built-in</Text>
        {builtins.map(([group, tools]) => (
          <View key={group} style={styles.groupBlock}>
            <Text style={styles.groupLabel}>{group}</Text>
            {tools.map((t) => (
              <View key={t.name} style={styles.toolRow}>
                <View style={styles.rowMain}>
                  <Text style={styles.toolName}>{t.name}</Text>
                  <Text style={styles.rowHint} numberOfLines={1}>
                    {t.description}
                  </Text>
                </View>
                <Switch
                  value={!disabled.includes(t.name)}
                  onValueChange={(on) => setDisabled(t.name, !on)}
                  trackColor={{ true: color.amberDeep, false: color.bg2 }}
                  thumbColor={!disabled.includes(t.name) ? color.amber : color.faint}
                />
              </View>
            ))}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function McpForm({
  onAdd,
  onCancel,
}: {
  onAdd: (s: McpServerConfig) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [auth, setAuth] = useState('');
  return (
    <View style={styles.form}>
      <Input label="Name" value={name} onChange={setName} placeholder="slack" />
      <Input label="URL" value={url} onChange={setUrl} placeholder="https://mcp.example.com/mcp" />
      <Input
        label='Auth (optional): "Bearer KEY" or "header-name: KEY"'
        value={auth}
        onChange={setAuth}
        placeholder="x-api-key: ak_…"
        secure
      />
      <FormButtons
        canSave={name.trim() !== '' && url.trim().startsWith('http')}
        onSave={() => onAdd({ name: name.trim(), url: url.trim(), auth: auth.trim() })}
        onCancel={onCancel}
      />
    </View>
  );
}

function CustomForm({
  onAdd,
  onCancel,
}: {
  onAdd: (t: CustomHttpTool) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [url, setUrl] = useState('');
  const [method, setMethod] = useState<'GET' | 'POST'>('GET');
  const [headersJson, setHeadersJson] = useState('');
  const [params, setParams] = useState('');
  return (
    <View style={styles.form}>
      <Input label="Tool name (snake_case)" value={name} onChange={setName} placeholder="check_weather" />
      <Input
        label="Description (the model reads this)"
        value={description}
        onChange={setDescription}
        placeholder="Get the weather for a city"
      />
      <Input label="URL" value={url} onChange={setUrl} placeholder="https://api.example.com/weather" />
      <View style={styles.methodRow}>
        {(['GET', 'POST'] as const).map((m) => (
          <TouchableOpacity
            key={m}
            style={[styles.methodBtn, method === m && styles.methodBtnOn]}
            onPress={() => setMethod(m)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={[styles.methodText, method === m && styles.methodTextOn]}>{m}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Input
        label='Parameters ("name: description, name: description")'
        value={params}
        onChange={setParams}
        placeholder="city: the city to check"
      />
      <Input
        label="Headers JSON (optional)"
        value={headersJson}
        onChange={setHeadersJson}
        placeholder='{"x-api-key": "…"}'
      />
      <FormButtons
        canSave={name.trim() !== '' && description.trim() !== '' && url.trim().startsWith('http')}
        onSave={() =>
          onAdd({
            name: name.trim(),
            description: description.trim(),
            url: url.trim(),
            method,
            headersJson: headersJson.trim(),
            params: params.trim(),
          })
        }
        onCancel={onCancel}
      />
    </View>
  );
}

function Input({
  label,
  value,
  onChange,
  placeholder,
  secure,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  secure?: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.fieldInput}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={color.faint}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={secure}
      />
    </View>
  );
}

function FormButtons({
  canSave,
  onSave,
  onCancel,
}: {
  canSave: boolean;
  onSave: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.formButtons}>
      <TouchableOpacity style={[styles.saveBtn, !canSave && styles.saveBtnOff]} disabled={!canSave} onPress={onSave}>
        <Text style={styles.saveText}>Save</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onCancel} hitSlop={8}>
        <Text style={styles.cancelText}>Cancel</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg0 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: space(4),
    paddingVertical: space(3),
  },
  title: { color: color.text, fontSize: 20, fontWeight: '800' },
  close: { color: color.amber, fontSize: 15, fontWeight: '600' },
  body: { padding: space(4), gap: space(2), paddingBottom: space(10) },
  blurb: { color: color.dim, fontSize: 13, lineHeight: 19 },
  sectionLabel: {
    color: color.faint,
    fontSize: 11,
    fontFamily: font.mono,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginTop: space(3),
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: color.bg1,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: color.line,
    padding: space(3.5),
    gap: space(2),
  },
  rowMain: { flex: 1, gap: space(0.75) },
  rowTitle: { color: color.text, fontSize: 14, fontWeight: '600' },
  rowHint: { color: color.dim, fontSize: 12 },
  rowMeta: { color: color.faint, fontSize: 11, fontFamily: font.mono },
  err: { color: color.danger },
  delete: { color: color.faint, fontSize: 16 },
  actionsRow: { flexDirection: 'row', gap: space(2) },
  addBtn: {
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.chip,
    paddingHorizontal: space(3),
    paddingVertical: space(2),
    alignSelf: 'flex-start',
  },
  addBtnText: { color: color.cyan, fontSize: 13 },
  groupBlock: {
    backgroundColor: color.bg1,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: color.line,
    padding: space(3),
    gap: space(2),
  },
  groupLabel: { color: color.amber, fontSize: 11, fontFamily: font.mono, letterSpacing: 1 },
  toolRow: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  toolName: { color: color.text, fontSize: 13, fontFamily: font.mono },
  form: {
    backgroundColor: color.bg1,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: color.amberDeep,
    padding: space(3),
    gap: space(2),
  },
  field: { gap: space(1) },
  fieldLabel: { color: color.faint, fontSize: 11, fontFamily: font.mono },
  fieldInput: {
    color: color.text,
    fontSize: 14,
    backgroundColor: color.bg0,
    borderRadius: radius.chip,
    paddingHorizontal: space(2.5),
    paddingVertical: space(2),
  },
  methodRow: { flexDirection: 'row', gap: space(2) },
  methodBtn: {
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.chip,
    paddingHorizontal: space(3),
    paddingVertical: space(1.5),
  },
  methodBtnOn: { borderColor: color.amber },
  methodText: { color: color.faint, fontSize: 12, fontFamily: font.mono },
  methodTextOn: { color: color.amber },
  formButtons: { flexDirection: 'row', alignItems: 'center', gap: space(4), marginTop: space(1) },
  saveBtn: {
    backgroundColor: color.amber,
    borderRadius: radius.chip,
    paddingHorizontal: space(4),
    paddingVertical: space(2),
  },
  saveBtnOff: { opacity: 0.4 },
  saveText: { color: color.bg0, fontWeight: '700', fontSize: 13 },
  cancelText: { color: color.faint, fontSize: 13 },
});
