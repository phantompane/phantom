import {
  Check,
  ChevronDown,
  Pencil,
  Plus,
  Server,
  Settings2,
  Trash2,
  Wifi,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import {
  useConnections,
  type SaveConnectionResult,
} from "../connection-context";
import {
  getConnectionApiBaseUrl,
  getConnectionDisplayName,
  getConnectionEndpointLabel,
  validateConnectionInput,
  type ConnectionFieldErrors,
  type ConnectionInput,
  type SavedConnection,
} from "../connections";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

const defaultConnectionInput: ConnectionInput = {
  host: "",
  name: "",
  port: "9640",
  protocol: "http",
};

type ManagerMode = "add" | "list";

export function ConnectionSetup() {
  const navigate = useNavigate();
  const { addConnection } = useConnections();

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4 py-8 text-foreground">
      <section className="grid w-full max-w-lg gap-5 rounded-[var(--radius-lg)] border border-border bg-card p-6 shadow-[var(--shadow-lg)]">
        <div className="flex size-11 items-center justify-center rounded-[var(--radius-md)] bg-primary text-primary-foreground">
          <Server className="size-5" />
        </div>
        <DialogHeader>
          <DialogTitle>Connect to Phantom</DialogTitle>
          <DialogDescription>
            Run the Phantom server, then save its hostname or IP address here.
            Connections stay in this browser and can be changed later.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-[var(--radius-sm)] border border-[var(--border-divider)] bg-[var(--surface-code)] px-3 py-2 font-mono text-[length:var(--font-size-sm)]">
          phantom serve
        </div>
        <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
          Connecting from another device? Start with{" "}
          <code>phantom serve --host 0.0.0.0</code> and enter the server
          device&apos;s reachable address below.
        </p>
        <ConnectionEditorForm
          initialInput={defaultConnectionInput}
          submitLabel="Save and connect"
          onSave={(input) => {
            const result = addConnection(input);
            if (result.ok) {
              navigate("/", { replace: true });
            }
            return result;
          }}
        />
      </section>
    </main>
  );
}

export function ConnectionSwitcher() {
  const navigate = useNavigate();
  const { activeConnection, availableConnections, selectConnection } =
    useConnections();
  const [managerMode, setManagerMode] = useState<ManagerMode>("list");
  const [isManagerOpen, setIsManagerOpen] = useState(false);

  if (!activeConnection) {
    return null;
  }

  function openManager(mode: ManagerMode) {
    setManagerMode(mode);
    setIsManagerOpen(true);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`Connected to ${activeConnection.displayName}`}
            className="h-8 min-w-0 max-w-48 gap-1.5 px-2 text-[var(--icon-color-default)]"
            title={`${activeConnection.displayName} (${activeConnection.endpointLabel})`}
            type="button"
            variant="ghost"
          >
            <Server className="size-4" />
            <span className="hidden min-w-0 truncate sm:block">
              {activeConnection.displayName}
            </span>
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel>Phantom instances</DropdownMenuLabel>
          {availableConnections.map((connection) => (
            <DropdownMenuItem
              className="items-start"
              key={connection.id}
              onSelect={() => {
                if (connection.id === activeConnection.id) {
                  return;
                }
                navigate("/", { replace: true });
                selectConnection(connection.id);
              }}
            >
              <span className="mt-0.5 flex size-4 items-center justify-center">
                {connection.id === activeConnection.id && <Check />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {connection.displayName}
                </span>
                <span className="block truncate text-[length:var(--font-size-xs)] text-muted-foreground">
                  {connection.endpointLabel}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => openManager("add")}>
            <Plus />
            Add connection
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openManager("list")}>
            <Settings2 />
            Manage connections
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConnectionManagerDialog
        key={`${managerMode}:${isManagerOpen}`}
        initialMode={managerMode}
        open={isManagerOpen}
        onOpenChange={setIsManagerOpen}
      />
    </>
  );
}

function ConnectionManagerDialog({
  initialMode,
  onOpenChange,
  open,
}: {
  initialMode: ManagerMode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const navigate = useNavigate();
  const {
    activeConnection,
    addConnection,
    removeConnection,
    savedConnections,
    updateConnection,
  } = useConnections();
  const [mode, setMode] = useState<ManagerMode>(initialMode);
  const [editingConnectionId, setEditingConnectionId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    setMode(initialMode);
    setEditingConnectionId(null);
  }, [initialMode, open]);

  const editingConnection = editingConnectionId
    ? (savedConnections.find(
        (connection) => connection.id === editingConnectionId,
      ) ?? null)
    : null;
  const isEditing = Boolean(editingConnection);
  const editorInput = editingConnection
    ? connectionToInput(editingConnection)
    : defaultConnectionInput;

  function saveConnection(input: ConnectionInput): SaveConnectionResult {
    const previousActiveConnection = activeConnection;
    const result = editingConnection
      ? updateConnection(editingConnection.id, input)
      : addConnection(input);
    if (!result.ok) {
      return result;
    }

    const activeEndpointChanged =
      previousActiveConnection?.id === editingConnection?.id &&
      previousActiveConnection?.apiBaseUrl !==
        getConnectionApiBaseUrl(result.connection);
    if (!editingConnection || activeEndpointChanged) {
      navigate("/", { replace: true });
    }
    setMode("list");
    setEditingConnectionId(null);
    return result;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-labelledby="connection-manager-title"
        className="max-h-[min(44rem,calc(100dvh-2rem))] overflow-y-auto"
      >
        {mode === "list" ? (
          <>
            <DialogHeader>
              <DialogTitle id="connection-manager-title">
                Manage connections
              </DialogTitle>
              <DialogDescription>
                Saved Phantom instances are available whenever you open this
                browser.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              {savedConnections.length === 0 ? (
                <div className="rounded-[var(--radius-sm)] border border-dashed border-border px-3 py-4 text-[length:var(--font-size-sm)] text-muted-foreground">
                  No saved connections yet.
                </div>
              ) : (
                savedConnections.map((connection) => (
                  <div
                    className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border-divider)] bg-[var(--surface-card)] p-3"
                    key={connection.id}
                  >
                    <Server className="size-4 shrink-0 text-[var(--icon-color-default)]" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-[length:var(--font-size-sm)] font-medium">
                          {getConnectionDisplayName(connection)}
                        </p>
                        {activeConnection?.id === connection.id && (
                          <Badge variant="success">Active</Badge>
                        )}
                      </div>
                      <p className="truncate text-[length:var(--font-size-xs)] text-muted-foreground">
                        {getConnectionEndpointLabel(connection)}
                      </p>
                    </div>
                    <Button
                      aria-label={`Edit ${getConnectionDisplayName(connection)}`}
                      onClick={() => {
                        setEditingConnectionId(connection.id);
                        setMode("add");
                      }}
                      size="icon"
                      title="Edit connection"
                      type="button"
                      variant="ghost"
                    >
                      <Pencil />
                    </Button>
                    <Button
                      aria-label={`Delete ${getConnectionDisplayName(connection)}`}
                      className="text-[var(--semantic-danger-fg)]"
                      onClick={() => {
                        if (activeConnection?.id === connection.id) {
                          navigate("/", { replace: true });
                        }
                        removeConnection(connection.id);
                      }}
                      size="icon"
                      title="Delete connection"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))
              )}
            </div>
            <DialogFooter>
              <Button
                onClick={() => onOpenChange(false)}
                type="button"
                variant="outline"
              >
                Close
              </Button>
              <Button
                onClick={() => {
                  setEditingConnectionId(null);
                  setMode("add");
                }}
                type="button"
              >
                <Plus />
                Add connection
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle id="connection-manager-title">
                {isEditing ? "Edit connection" : "Add connection"}
              </DialogTitle>
              <DialogDescription>
                {isEditing
                  ? "Update the address used for this Phantom instance."
                  : "Save another Phantom instance and switch to it."}
              </DialogDescription>
            </DialogHeader>
            <ConnectionEditorForm
              key={editingConnection?.id ?? "new-connection"}
              initialInput={editorInput}
              submitLabel={isEditing ? "Save changes" : "Save and connect"}
              onCancel={() => {
                setEditingConnectionId(null);
                setMode("list");
              }}
              onSave={saveConnection}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ConnectionEditorForm({
  initialInput,
  onCancel,
  onSave,
  submitLabel,
}: {
  initialInput: ConnectionInput;
  onCancel?: () => void;
  onSave: (input: ConnectionInput) => SaveConnectionResult;
  submitLabel: string;
}) {
  const [input, setInput] = useState<ConnectionInput>(initialInput);
  const [errors, setErrors] = useState<ConnectionFieldErrors>({});
  const [testState, setTestState] = useState<
    | { message: string; tone: "danger" | "success" }
    | { message: string; tone: "testing" }
    | null
  >(null);
  const testRequestRef = useRef<AbortController | null>(null);
  const endpointPreview = useMemo(() => {
    const validation = validateConnectionInput(input);
    return validation.ok ? getConnectionApiBaseUrl(validation.value) : null;
  }, [input]);

  useEffect(
    () => () => {
      testRequestRef.current?.abort();
    },
    [],
  );

  function updateInput(field: keyof ConnectionInput, value: string) {
    testRequestRef.current?.abort();
    testRequestRef.current = null;
    setInput((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({
      ...current,
      [field]: undefined,
      form: undefined,
    }));
    setTestState(null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = onSave(input);
    if (!result.ok) {
      setErrors(result.errors);
    }
  }

  async function testConnection() {
    const validation = validateConnectionInput(input);
    if (!validation.ok) {
      setErrors(validation.errors);
      return;
    }

    setErrors({});
    setTestState({ message: "Testing connection…", tone: "testing" });
    testRequestRef.current?.abort();
    const controller = new AbortController();
    testRequestRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 6_000);
    try {
      const response = await fetch(
        `${getConnectionApiBaseUrl(validation.value)}/health`,
        {
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        },
      );
      const body = (await response.json().catch(() => null)) as unknown;
      if (testRequestRef.current !== controller) {
        return;
      }
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}.`);
      }
      if (!isRecord(body) || body.ok !== true) {
        throw new Error(
          "The endpoint did not return a Phantom health response.",
        );
      }
      setTestState({ message: "Connection successful.", tone: "success" });
    } catch (error) {
      if (testRequestRef.current !== controller) {
        return;
      }
      const message =
        error instanceof DOMException && error.name === "AbortError"
          ? "Connection timed out."
          : error instanceof Error
            ? error.message
            : "Could not connect to this endpoint.";
      setTestState({ message, tone: "danger" });
    } finally {
      window.clearTimeout(timeout);
      if (testRequestRef.current === controller) {
        testRequestRef.current = null;
      }
    }
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <div className="grid gap-2">
        <Label htmlFor="connection-name">Name (optional)</Label>
        <Input
          aria-describedby={errors.name ? "connection-name-error" : undefined}
          aria-invalid={Boolean(errors.name)}
          id="connection-name"
          placeholder="Home Mac"
          value={input.name ?? ""}
          onChange={(event) => updateInput("name", event.target.value)}
        />
        <FieldError id="connection-name-error" message={errors.name} />
      </div>
      <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
        <div className="grid gap-2">
          <Label htmlFor="connection-protocol">Protocol</Label>
          <select
            aria-describedby={
              errors.protocol ? "connection-protocol-error" : undefined
            }
            aria-invalid={Boolean(errors.protocol)}
            className="h-9 rounded-[var(--radius-sm)] border border-input bg-[var(--surface-input)] px-3 text-[length:var(--font-size-sm)] shadow-[var(--shadow-xs)] outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:shadow-[var(--state-focus-ring)]"
            id="connection-protocol"
            value={input.protocol}
            onChange={(event) => updateInput("protocol", event.target.value)}
          >
            <option value="http">HTTP</option>
            <option value="https">HTTPS</option>
          </select>
          <FieldError
            id="connection-protocol-error"
            message={errors.protocol}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="connection-host">Host or IP address</Label>
          <Input
            aria-describedby={errors.host ? "connection-host-error" : undefined}
            aria-invalid={Boolean(errors.host)}
            autoCapitalize="none"
            autoCorrect="off"
            id="connection-host"
            placeholder="192.168.1.20"
            spellCheck={false}
            value={input.host}
            onChange={(event) => updateInput("host", event.target.value)}
          />
          <FieldError id="connection-host-error" message={errors.host} />
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="connection-port">Port (optional)</Label>
        <Input
          aria-describedby={errors.port ? "connection-port-error" : undefined}
          aria-invalid={Boolean(errors.port)}
          id="connection-port"
          inputMode="numeric"
          max="65535"
          min="1"
          placeholder="9640"
          type="number"
          value={input.port ?? ""}
          onChange={(event) => updateInput("port", event.target.value)}
        />
        <FieldError id="connection-port-error" message={errors.port} />
      </div>
      <div className="rounded-[var(--radius-sm)] border border-[var(--border-divider)] bg-[var(--surface-code)] px-3 py-2">
        <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
          API endpoint
        </p>
        <p className="truncate font-mono text-[length:var(--font-size-sm)]">
          {endpointPreview ?? "Complete the fields to preview the endpoint"}
        </p>
      </div>
      {input.protocol === "http" && window.location.protocol === "https:" && (
        <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
          Your browser may ask for local-network access or block HTTP endpoints.
          Use HTTPS if your browser blocks the connection.
        </p>
      )}
      {errors.form && (
        <p
          className="rounded-[var(--radius-sm)] border border-[var(--semantic-danger-border)] bg-[var(--semantic-danger-bg)] px-3 py-2 text-[length:var(--font-size-sm)] text-[var(--semantic-danger-fg)]"
          role="alert"
        >
          {errors.form}
        </p>
      )}
      {testState && (
        <p
          aria-live="polite"
          className={
            testState.tone === "success"
              ? "flex items-center gap-2 text-[length:var(--font-size-sm)] text-[var(--semantic-success-fg)]"
              : testState.tone === "danger"
                ? "flex items-center gap-2 text-[length:var(--font-size-sm)] text-[var(--semantic-danger-fg)]"
                : "flex items-center gap-2 text-[length:var(--font-size-sm)] text-muted-foreground"
          }
          role={testState.tone === "danger" ? "alert" : "status"}
        >
          {testState.tone === "success" ? <Check /> : <Wifi />}
          {testState.message}
        </p>
      )}
      <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
        Testing is optional. You can save an instance while it is offline.
      </p>
      <DialogFooter className="flex-wrap">
        {onCancel && (
          <Button onClick={onCancel} type="button" variant="outline">
            Cancel
          </Button>
        )}
        <Button
          disabled={testState?.tone === "testing"}
          onClick={() => void testConnection()}
          type="button"
          variant="outline"
        >
          <Wifi />
          Test connection
        </Button>
        <Button type="submit">{submitLabel}</Button>
      </DialogFooter>
    </form>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p
      className="text-[length:var(--font-size-xs)] text-[var(--semantic-danger-fg)]"
      id={id}
    >
      {message}
    </p>
  ) : null;
}

function connectionToInput(connection: SavedConnection): ConnectionInput {
  return {
    host: connection.host,
    name: connection.name ?? "",
    port: connection.port === null ? "" : String(connection.port),
    protocol: connection.protocol,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
