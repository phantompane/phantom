import { useEffect, useState } from "react";
import { Outlet, useNavigate } from "react-router";
import { useConnections } from "../connection-context";
import { ConnectionSetup } from "../components/connection-controls";
import "../styles.css";

export function RootRoute() {
  const { activeConnection } = useConnections();
  const navigate = useNavigate();
  const connectionKey = activeConnection?.connectionKey ?? null;
  const [renderedConnectionKey, setRenderedConnectionKey] =
    useState(connectionKey);
  const connectionChanged = renderedConnectionKey !== connectionKey;

  useEffect(() => {
    if (!connectionChanged) {
      return;
    }
    navigate("/", { replace: true });
    setRenderedConnectionKey(connectionKey);
  }, [connectionChanged, connectionKey, navigate]);

  if (connectionChanged) {
    return null;
  }

  if (!activeConnection) {
    return <ConnectionSetup />;
  }
  return <Outlet key={activeConnection.connectionKey} />;
}
