/*
 * main module for render process
 */
import "source-map-support/register";
import * as React from "react";
import * as ReactDOM from "react-dom";
import OneRef, { mkRef, refContainer, mutableGet, StateRef } from "oneref";
import { AppPane, AppPaneBaseProps } from "tadviewer";
import { PivotRequester } from "tadviewer";
import { AppState } from "tadviewer";
import { ViewParams, actions } from "tadviewer";
import { initAppState } from "tadviewer";
import * as reltab from "reltab";
import log from "loglevel";
import { ElectronTransportClient } from "./electronClient";
import * as electron from "electron";
import {
  DataSourcePath,
  DataSourceId,
  RemoteReltabConnection,
  TableInfo,
} from "reltab";
import { OpenParams } from "./openParams";

const remote = electron.remote;
const remoteInitMain = remote.getGlobal("initMain");
const remoteErrorDialog = remote.getGlobal("errorDialog");
const remoteImportCSV = remote.getGlobal("importCSV");
const remoteImportParquet = remote.getGlobal("importParquet");
const remoteNewWindowFromDSPath = remote.getGlobal("newWindowFromDSPath");

const ipcRenderer = electron.ipcRenderer;

type InitInfo = {
  connKey: DataSourceId;
};

let delay = (ms: number) => {
  if (ms > 0) {
    log.log("injecting delay of ", ms, " ms");
  }

  return new Promise((resolve) => setTimeout(resolve, ms));
};

const initMainProcess = (): Promise<void> => {
  return new Promise((resolve, reject) => {
    remoteInitMain((err: any) => {
      if (err) {
        console.error("initMain error: ", err);
        reject(err);
      } else {
        console.log("initMain complete");
        resolve();
      }
    });
  });
};

const importCSV = (targetPath: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    remoteImportCSV(targetPath, (err: any, tableName: string) => {
      if (err) {
        console.error("importCSV error: ", err);
        reject(err);
      } else {
        resolve(tableName);
      }
    });
  });
};

const importParquet = (targetPath: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    remoteImportParquet(targetPath, (err: any, tableName: string) => {
      if (err) {
        console.error("importParquet error: ", err);
        reject(err);
      } else {
        resolve(tableName);
      }
    });
  });
};

const newWindowFromDSPath = (
  dsPath: DataSourcePath,
  stateRef: StateRef<AppState>
) => {
  return new Promise((resolve, reject) => {
    remoteNewWindowFromDSPath(
      JSON.stringify(dsPath),
      (err: any, displayName: string) => {
        if (err) {
          console.error("importParquet error: ", err);
          reject(err);
        } else {
          resolve(displayName);
        }
      }
    );
  });
};

// TODO: figure out how to initialize based on saved views or different file / table names
const init = async () => {
  const tStart = performance.now();
  log.setLevel(log.levels.DEBUG);
  // console.log("testing, testing, one two...");
  log.debug("Hello, Electron!");
  const win = remote.getCurrentWindow() as any;
  let viewParams: ViewParams | null = null;
  const appState = new AppState();
  const stateRef = mkRef(appState);
  const [App, listenerId] = refContainer<AppState, AppPaneBaseProps>(
    stateRef,
    AppPane
  );

  try {
    await initMainProcess();

    const tconn = new ElectronTransportClient();

    const rtc = new RemoteReltabConnection(tconn);

    var pivotRequester: PivotRequester | undefined | null = null;

    await initAppState(rtc, stateRef);

    ReactDOM.render(
      <App newWindow={newWindowFromDSPath} />,
      document.getElementById("app")
    );
    const tRender = performance.now();
    log.debug("Time to initial render: ", (tRender - tStart) / 1000, " sec");
    pivotRequester = new PivotRequester(stateRef);

    let targetDSPath: DataSourcePath | null = null;

    const openParams = win.openParams as OpenParams | undefined;
    if (openParams) {
      actions.startAppLoadingTimer(stateRef);
      switch (openParams.openType) {
        case "fspath":
          const connKey: DataSourceId = {
            providerName: "localfs",
            resourceId: openParams.path,
          };
          targetDSPath = { sourceId: connKey, path: ["."] };
          break;
        case "dspath":
          targetDSPath = openParams.dsPath;
          break;
        case "tad":
          const parsedFileState = JSON.parse(openParams.fileContents!);
          // This would be the right place to validate / migrate tadFileFormatVersion
          const savedFileState = parsedFileState.contents;
          targetDSPath = savedFileState.dsPath;
          console.log("tad file: ", targetDSPath, savedFileState);
          viewParams = ViewParams.deserialize(savedFileState.viewParams);
          console.log("tad file: decoded viewParams: ", viewParams.toJS());
          break;
      }
      if (targetDSPath !== null) {
        const conn = await rtc.connect(targetDSPath.sourceId);
        const rootNode = await conn.getRootNode();
        await actions.openDataSourcePath(
          targetDSPath,
          stateRef,
          viewParams ?? undefined
        );
      }
      actions.stopAppLoadingTimer(stateRef);
    }
    ipcRenderer.on("request-serialize-app-state", (event, req) => {
      console.log("got request-serialize-app-state: ", req);
      const { requestId } = req;
      const curState = mutableGet(stateRef);
      const viewState = curState.viewState;
      console.log("serialize-app-state: viewState: ", viewState);
      const { dsPath } = viewState;
      const viewParamsJS = viewState.viewParams.toJS();
      const serState = {
        dsPath,
        viewParams: viewParamsJS,
      };
      ipcRenderer.send("response-serialize-app-state", {
        requestId,
        contents: serState,
      });
    });
    ipcRenderer.on("set-show-hidden-cols", (event, val) => {
      actions.setShowHiddenCols(val, stateRef);
    });
    ipcRenderer.on("request-serialize-filter-query", (event, req) => {
      console.log("got request-serialize-filter-query: ", req);
      const { requestId } = req;
      const curState = mutableGet(stateRef);
      const baseQuery = curState.viewState.baseQuery;
      const viewParams = curState.viewState.viewParams;
      const filterRowCount = curState.viewState.queryView!.filterRowCount;
      const queryObj = {
        query: baseQuery.filter(viewParams.filterExp),
        filterRowCount,
      };
      const contents = JSON.stringify(queryObj, null, 2);
      ipcRenderer.send("response-serialize-filter-query", {
        requestId,
        contents,
      });
    });
    ipcRenderer.on("open-export-dialog", (event, req) => {
      const { openState, saveFilename } = req;
      actions.setExportDialogOpen(openState, saveFilename, stateRef);
    });
    ipcRenderer.on("export-progress", (event, req) => {
      const { percentComplete } = req;
      actions.setExportProgress(percentComplete, stateRef);
    });
  } catch (e) {
    const err = e as any;
    console.error(
      "renderMain: caught error during initialization: ",
      err.message,
      err.stack
    );
    remoteErrorDialog("Error initializing Tad", err.message, true);
  }
};
console.log("before init");
init();
