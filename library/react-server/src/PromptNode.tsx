import React, {
  useEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
  useContext,
} from "react";
import { Handle, Position } from "reactflow";
import { v4 as uuid } from "uuid";
import {
  Switch,
  Progress,
  Textarea,
  Text,
  Popover,
  Center,
  Modal,
  Box,
  Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconEraser, IconList } from "@tabler/icons-react";
import useStore from "./store";
import BaseNode from "./BaseNode";
import NodeLabel from "./NodeLabelComponent";
import TemplateHooks, {
  extractBracketedSubstrings,
} from "./TemplateHooksComponent";
import { LLMListContainer, LLMListContainerRef } from "./LLMListComponent";
import { RAGListContainer, RAGListContainerRef } from "./RAGListComponent";
import LLMResponseInspectorModal, {
  LLMResponseInspectorModalRef,
} from "./LLMResponseInspectorModal";
import {
  PromptPermutationGenerator,
  PromptTemplate,
  escapeBraces,
} from "./backend/template";
import ChatHistoryView from "./ChatHistoryView";
import InspectFooter from "./InspectFooter";
import {
  countNumLLMs,
  setsAreEqual,
  getLLMsInPulledInputData,
  extractSettingsVars,
  truncStr,
  genDebounceFunc,
  index_file,
} from "./backend/utils";
import LLMResponseInspectorDrawer from "./LLMResponseInspectorDrawer";
import CancelTracker from "./backend/canceler";
import { UserForcedPrematureExit } from "./backend/errors";
import {
  ChatHistoryInfo,
  Dict,
  LLMSpec,
  QueryProgress,
  LLMResponse,
  TemplateVarInfo,
  ModelSettingsDict,
} from "./backend/typing";
import { AlertModalContext } from "./AlertModal";
import { Status } from "./StatusIndicatorComponent";
import {
  caching_responses,
  clearCachedResponses,
  countQueries,
  generatePrompts,
  grabResponses,
  queryLLM,
  queryRAG,
} from "./backend/backend";
import { typecastRagSettingsDict } from "./ModelSettingSchemas";

const getUniqueLLMMetavarKey = (responses: LLMResponse[]) => {
  const metakeys = new Set(
    responses.map((resp_obj) => Object.keys(resp_obj.metavars)).flat(),
  );
  let i = 0;
  while (metakeys.has(`LLM_${i}`)) i += 1;
  return `LLM_${i}`;
};

const getUniqueRAGMetavarKey = (responses: LLMResponse[]) => {
  const metakeys = new Set(
    responses.map((resp_obj) => Object.keys(resp_obj.metavars)).flat(),
  );
  let i = 0;
  while (metakeys.has(`RAG_${i}`)) i += 1;
  return `RAG_${i}`;
};
const bucketChatHistoryInfosByLLM = (chat_hist_infos: ChatHistoryInfo[]) => {
  const chats_by_llm: Dict<ChatHistoryInfo[]> = {};
  chat_hist_infos.forEach((chat_hist_info) => {
    const llm_name = chat_hist_info.llm ?? "undefined";
    if (llm_name in chats_by_llm) chats_by_llm[llm_name].push(chat_hist_info);
    else chats_by_llm[llm_name] = [chat_hist_info];
  });
  return chats_by_llm;
};

class PromptInfo {
  prompt: string;
  settings: Dict;

  constructor(prompt: string, settings: Dict) {
    this.prompt = prompt;
    this.settings = settings;
  }
}

const displayPromptInfos = (promptInfos: PromptInfo[], wideFormat: boolean) =>
  promptInfos.map((info, idx) => (
    <div key={idx}>
      <div className="prompt-preview">{info.prompt}</div>
      {info.settings ? (
        Object.entries(info.settings).map(([key, val]) => {
          return (
            <div key={key} className="settings-var-inline response-var-inline">
              <span className="response-var-name">{key}&nbsp;=&nbsp;</span>
              <span className="response-var-value wrap-line">
                {truncStr(val.toString(), wideFormat ? 512 : 72)}
              </span>
            </div>
          );
        })
      ) : (
        <></>
      )}
    </div>
  ));

export interface PromptListPopoverProps {
  promptInfos: PromptInfo[];
  onHover: () => void;
  onClick: () => void;
}

const PromptListPopover: React.FC<PromptListPopoverProps> = ({
  promptInfos,
  onHover,
  onClick,
}) => {
  const [opened, { close, open }] = useDisclosure(false);

  const _onHover = useCallback(() => {
    onHover();
    open();
  }, [onHover, open]);

  return (
    <Popover
      position="right-start"
      withArrow
      withinPortal
      shadow="rgb(38, 57, 77) 0px 10px 30px -14px"
      key="query-info"
      opened={opened}
      styles={{
        dropdown: {
          maxHeight: "500px",
          maxWidth: "400px",
          overflowY: "auto",
          backgroundColor: "#fff",
        },
      }}
    >
      <Popover.Target>
        <Tooltip label="Click to view all prompts" withArrow>
          <button
            className="custom-button"
            onMouseEnter={_onHover}
            onMouseLeave={close}
            onClick={onClick}
            style={{ border: "none" }}
          >
            <IconList
              size="12pt"
              color="gray"
              style={{ marginBottom: "-4px" }}
            />
          </button>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown sx={{ pointerEvents: "none" }}>
        <Center>
          <Text size="xs" fw={500} color="#666">
            Preview of generated prompts ({promptInfos.length} total)
          </Text>
        </Center>
        {displayPromptInfos(promptInfos, false)}
      </Popover.Dropdown>
    </Popover>
  );
};

export interface PromptNodeProps {
  data: {
    title: string;
    vars: string[];
    llms: LLMSpec[];
    rags: LLMSpec[];
    prompt: string;
    n: number;
    contChat: boolean;
    refresh: boolean;
    refreshLLMList: boolean;
  };
  id: string;
  type: string;
}

const PromptNode: React.FC<PromptNodeProps> = ({
  data,
  id,
  type: node_type,
}) => {
  const node_icon = useMemo(
    () => (node_type === "chat" ? "🗣" : "💬"),
    [node_type],
  );
  const node_default_title = useMemo(
    () => (node_type === "chat" ? "Chat Turn" : "Prompt Node"),
    [node_type],
  );

  // Get state from the Zustand store:
  const edges = useStore((state) => state.edges);
  const pullInputData = useStore((state) => state.pullInputData);
  const getImmediateInputNodeTypes = useStore(
    (state) => state.getImmediateInputNodeTypes,
  );
  const getImmediateInputNode = useStore(
    (state) => state.getImmediateInputNode,
  );
  const setDataPropsForNode = useStore((state) => state.setDataPropsForNode);
  const pingOutputNodes = useStore((state) => state.pingOutputNodes);
  const bringNodeToFront = useStore((state) => state.bringNodeToFront);

  // API Keys (set by user in popup GlobalSettingsModal)
  const apiKeys = useStore((state) => state.apiKeys);

  const [jsonResponses, setJSONResponses] = useState<LLMResponse[] | null>(
    null,
  );
  const [templateVars, setTemplateVars] = useState<string[]>(data.vars ?? []);
  const [promptText, setPromptText] = useState<string>(data.prompt ?? "");
  const [promptTextOnLastRun, setPromptTextOnLastRun] = useState<string | null>(
    null,
  );
  const [status, setStatus] = useState(Status.NONE);
  const [numGenerations, setNumGenerations] = useState<number>(data.n ?? 1);
  const [numGenerationsLastRun, setNumGenerationsLastRun] = useState<number>(
    data.n ?? 1,
  );

  // The LLM items container
  const llmListContainer = useRef<LLMListContainerRef>(null);
  const ragListContainer = useRef<RAGListContainerRef>(null);
  const [llmItemsCurrState, setLLMItemsCurrState] = useState<LLMSpec[]>([]);
  const [ragItemsCurrState, setRAGItemsCurrState] = useState<LLMSpec[]>([]);

  // For displaying error messages to user
  const showAlert = useContext(AlertModalContext);

  // For a way to inspect responses without having to attach a dedicated node
  const inspectModal = useRef<LLMResponseInspectorModalRef>(null);
  // eslint-disable-next-line
  const [uninspectedResponses, setUninspectedResponses] = useState(false);
  const [responsesWillChange, setResponsesWillChange] = useState(false);
  const [showDrawer, setShowDrawer] = useState(false);

  // For continuing with prior LLMs toggle
  const [contWithPriorLLMs, setContWithPriorLLMs] = useState<boolean>(
    data.contChat !== undefined ? data.contChat : node_type === "chat",
  );
  // For continuing with prior RAGs toggle
  const [contWithPriorRAGs, setContWithPriorRAGs] = useState<boolean>(
    data.contChat !== undefined ? data.contChat : node_type === "chat",
  );
  const [showContToggle, setShowContToggle] = useState<boolean>(
    node_type === "chat",
  );
  const [contToggleDisabled, setContChatToggleDisabled] = useState(false);

  // For an info pop-up that shows all the prompts that will be sent off
  // NOTE: This is the 'full' version of the PromptListPopover that activates on hover.
  const [infoModalOpened, { open: openInfoModal, close: closeInfoModal }] =
    useDisclosure(false);

  // Progress when querying responses
  const [progress, setProgress] = useState<QueryProgress | undefined>(
    undefined,
  );
  const [progressAnimated, setProgressAnimated] = useState(true);
  const [runTooltip, setRunTooltip] = useState<string | undefined>(undefined);

  // Cancelation of pending queries
  const [cancelId, setCancelId] = useState(Date.now());
  const refreshCancelId = () => setCancelId(Date.now());

  // Debounce helpers
  const debounceTimeoutRef = useRef(null);
  const debounce = genDebounceFunc(debounceTimeoutRef);

  const queryString = window.location.search;
  const urlParams = new URLSearchParams(queryString);

  const triggerAlert = useCallback(
    (msg: string) => {
      setProgress(undefined);
      llmListContainer?.current?.resetLLMItemsProgress();
      if (showAlert) showAlert(msg);
    },
    [llmListContainer, showAlert],
  );

  const showResponseInspector = useCallback(() => {
    if (inspectModal && inspectModal.current && jsonResponses) {
      inspectModal.current?.trigger();
      setUninspectedResponses(false);
    }
  }, [inspectModal, jsonResponses]);

  // Signal that prompt node state is dirty; user should re-run:
  const signalDirty = useCallback(() => {
    if (promptTextOnLastRun !== null && status === Status.READY)
      setStatus(Status.WARNING);
  }, [promptTextOnLastRun, status]);

  const onLLMListItemsChange = useCallback(
    (new_items: LLMSpec[], old_items: LLMSpec[]) => {
      // Update the local and global state;
      setLLMItemsCurrState(new_items);
      setDataPropsForNode(id, { llms: new_items });

      // If there's been any change to the item list, signal dirty:
      if (
        new_items.length !== old_items.length ||
        !new_items.every((i) => old_items.some((s) => s.key === i.key))
      ) {
        signalDirty();
      } else if (
        !new_items.every((itemA) => {
          const itemB = old_items.find((b) => b.key === itemA.key);
          return (
            JSON.stringify(itemA.settings) === JSON.stringify(itemB?.settings)
          );
        })
      ) {
        signalDirty();
      }
    },
    [signalDirty],
  );

  const onRAGListItemsChange = useCallback(
    (new_items: LLMSpec[], old_items: LLMSpec[]) => {
      // Update the local and global state;
      setRAGItemsCurrState(new_items);
      setDataPropsForNode(id, { rags: new_items });
      if (new_items.length > 0) {
        // Debounce refreshing the template hooks so we don't annoy the user
        debounce(
          (_value) => refreshTemplateHooks(_value),
          100,
        )(promptText + " {rag_knowledge_base}");
      } else {
        debounce(
          (_value) => removeFromTemplateHooks(_value),
          100,
        )("rag_knowledge_base");
      }
      // If there's been any change to the item list, signal dirty:
      if (
        new_items.length !== old_items.length ||
        !new_items.every((i) => old_items.some((s) => s.key === i.key))
      ) {
        signalDirty();
      } else if (
        !new_items.every((itemA) => {
          const itemB = old_items.find((b) => b.key === itemA.key);
          return (
            JSON.stringify(itemA.settings) === JSON.stringify(itemB?.settings)
          );
        })
      ) {
        signalDirty();
      }
    },
    [signalDirty],
  );

  const updateShowContToggle = useCallback(
    (pulled_data: Dict<string[] | TemplateVarInfo[]>) => {
      if (node_type === "chat") return; // always show when chat node
      const hasPromptInput = getImmediateInputNodeTypes(templateVars, id).some(
        (t) => ["prompt", "chat"].includes(t),
      );

      setShowContToggle(
        hasPromptInput || (pulled_data && countNumLLMs(pulled_data) > 0),
      );
    },
    [
      setShowContToggle,
      countNumLLMs,
      getImmediateInputNodeTypes,
      templateVars,
      id,
    ],
  );

  const handleOnConnect = useCallback(() => {
    if (node_type === "chat") return; // always show when chat node
    // Re-pull data and update show cont toggle:
    try {
      const pulled_data = pullInputData(templateVars, id);
      updateShowContToggle(pulled_data);
    } catch (err) {
      console.error(err);
    }
  }, [templateVars, id, pullInputData, updateShowContToggle]);

  const removeFromTemplateHooks = useCallback(
    (text: string) => {
      // Update template var fields + handles
      const found_template_vars = new Set(
        extractBracketedSubstrings(promptText),
      );
      found_template_vars.delete(text);

      setTemplateVars(Array.from(found_template_vars));
    },
    [setTemplateVars, templateVars],
  );

  const refreshTemplateHooks = useCallback(
    (text: string) => {
      // Update template var fields + handles
      let found_template_vars = new Set(extractBracketedSubstrings(text));
      // gets all strs within braces {} that aren't escaped; e.g., ignores \{this\} but captures {this}
      if (ragItemsCurrState.length > 0) {
        found_template_vars = new Set([
          ...found_template_vars,
          "rag_knowledge_base",
        ]);
      }
      if (node_type !== "chat") {
        try {
          updateShowContToggle(
            pullInputData(Array.from(found_template_vars), id),
          );
        } catch (err) {
          console.error(err);
        }
      }
      setTemplateVars(Array.from(found_template_vars));
    },
    [setTemplateVars, templateVars, pullInputData, id],
  );

  const handleInputChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;

    // Store prompt text
    setPromptText(value);
    data.prompt = value;

    // Update status icon, if need be:
    if (
      promptTextOnLastRun !== null &&
      status !== Status.WARNING &&
      value !== promptTextOnLastRun
    )
      setStatus(Status.WARNING);

    // Debounce refreshing the template hooks so we don't annoy the user
    debounce((_value) => refreshTemplateHooks(_value), 500)(value);
  };

  // On initialization
  useEffect(() => {
    refreshTemplateHooks(promptText);

    // Attempt to grab cache'd responses
    grabResponses([id])
      .then(function (resps) {
        if (resps.length > 0) {
          // Store responses and set status to green checkmark
          setJSONResponses(resps);
          setStatus(Status.READY);
        }
      })
      .catch(() => {
        // soft fail
      });
  }, []);

  // On upstream changes
  const refresh = useMemo(() => data.refresh, [data.refresh]);
  const refreshLLMList = useMemo(
    () => data.refreshLLMList,
    [data.refreshLLMList],
  );
  useEffect(() => {
    if (refresh === true) {
      setDataPropsForNode(id, { refresh: false });
      setStatus(Status.WARNING);
      handleOnConnect();
    } else if (refreshLLMList === true) {
      llmListContainer?.current?.refreshLLMProviderList();
      ragListContainer?.current?.refreshRAGProviderList();
      setDataPropsForNode(id, { refreshLLMList: false });
    }
  }, [refresh, refreshLLMList]);

  // Chat nodes only. Pulls input data attached to the 'past conversations' handle.
  // Returns a tuple (past_chat_llms, __past_chats), where both are undefined if nothing is connected.
  const pullInputChats = () => {
    const pulled_data = pullInputData(["__past_chats"], id);
    if (!("__past_chats" in pulled_data)) return [undefined, undefined];

    // For storing the unique LLMs in past_chats:
    const llm_names = new Set();
    const past_chat_llms: (LLMSpec | string)[] = [];

    // Filter all inputs that have metadata (vars, metavars, etc) and aren't just string inputs.
    const past_chat_inputs = (
      pulled_data.__past_chats as TemplateVarInfo[]
    ).filter(
      (info: string | TemplateVarInfo) => typeof info !== "string",
    ) as TemplateVarInfo[];

    // We need to calculate the conversation history from the pulled responses.
    // Note that TemplateVarInfo might have a 'chat_history' component, but this does not
    // include the most recent prompt and response --for that, we need to use the 'prompt' and 'text' items.
    // We need to create a revised chat history that concatenates the past history with the last AI + human turns:
    const past_chats = past_chat_inputs.map<ChatHistoryInfo>(
      (info: TemplateVarInfo) => {
        // Add to unique LLMs list, if necessary
        if (
          typeof info?.llm !== "string" &&
          info?.llm?.name !== undefined &&
          !llm_names.has(info.llm.name)
        ) {
          llm_names.add(info.llm.name);
          past_chat_llms.push(info.llm);
        }

        // Create revised chat_history on the TemplateVarInfo object,
        // with the prompt and text of the pulled data as the 2nd-to-last, and last, messages:
        const last_messages = [
          { role: "user", content: info.prompt ?? "" },
          { role: "assistant", content: info.text ?? "" },
        ];
        let updated_chat_hist =
          info.chat_history !== undefined
            ? info.chat_history.concat(last_messages)
            : last_messages;

        // Append any present system message retroactively as the first message in the chat history:
        if (
          typeof info?.llm !== "string" &&
          typeof info?.llm?.settings?.system_msg === "string" &&
          updated_chat_hist[0].role !== "system"
        )
          updated_chat_hist = [
            { role: "system", content: info.llm.settings.system_msg },
          ].concat(updated_chat_hist);

        // ChatHistoryInfo format (see typing.ts)
        return {
          messages: updated_chat_hist,
          fill_history: info.fill_history ?? {},
          metavars: info.metavars ?? {},
          llm: typeof info?.llm === "string" ? info.llm : info?.llm?.name,
          uid: uuid(),
        };
      },
    );

    // Returns [list of LLM specs, list of ChatHistoryInfo]
    return [past_chat_llms, past_chats];
  };

  // Ask the backend how many responses it needs to collect, given the input data:
  const fetchResponseCounts = (
    prompt: string,
    vars: Dict,
    llms: (string | Dict)[],
    rags: (string | Dict)[],
    chat_histories?:
      | (ChatHistoryInfo | undefined)[]
      | Dict<(ChatHistoryInfo | undefined)[]>,
  ) => {
    return countQueries(
      prompt,
      vars,
      llms,
      rags,
      numGenerations,
      chat_histories,
      id,
      node_type !== "chat" ? showContToggle && contWithPriorLLMs : undefined,
    ).then(function (results) {
      return [results.counts, results.total_num_responses] as [
        Dict<Dict<number>>,
        Dict<number>,
      ];
    });
  };

  // On hover over the 'info' button, to preview the prompts that will be sent out
  const [promptPreviews, setPromptPreviews] = useState<PromptInfo[]>([]);
  const handlePreviewHover = () => {
    // Pull input data and prompt
    try {
      const pulled_vars = pullInputData(templateVars, id);
      updateShowContToggle(pulled_vars);

      generatePrompts(promptText, pulled_vars).then((prompts) => {
        setPromptPreviews(
          prompts.map(
            (p: PromptTemplate) =>
              new PromptInfo(p.toString(), extractSettingsVars(p.fill_history)),
          ),
        );
      });

      pullInputChats();
    } catch (err) {
      // soft fail
      console.error(err);
      setPromptPreviews([]);
    }
  };

  // On hover over the 'Run' button, request how many responses are required and update the tooltip. Soft fails.
  const handleRunHover = () => {
    // Check if the PromptNode is not already waiting for a response...
    if (status === "loading") {
      setRunTooltip("Fetching responses...");
      return;
    }

    let _llmItemsCurrState = llmItemsCurrState;
    let _ragItemsCurrState = ragItemsCurrState;

    // If this is a chat node, we also need to pull chat histories:
    const [past_chat_llms, pulled_chats] =
      node_type === "chat" ? pullInputChats() : [undefined, undefined];
    let chat_hist_by_llm: Dict<ChatHistoryInfo[]> | undefined;

    if (node_type === "chat" && contWithPriorLLMs) {
      if (past_chat_llms === undefined || pulled_chats === undefined) {
        setRunTooltip("Attach an input to past conversations first.");
        return;
      }
      _llmItemsCurrState = past_chat_llms as LLMSpec[];
      chat_hist_by_llm = bucketChatHistoryInfosByLLM(
        pulled_chats as ChatHistoryInfo[],
      );
    }

    // Pull the input data
    let pulled_vars = {};
    try {
      pulled_vars = pullInputData(templateVars, id);
    } catch (err) {
      setRunTooltip("Error: Duplicate variables detected.");
      console.error(err);
      return; // early exit
    }

    updateShowContToggle(pulled_vars);

    // Whether to continue with only the prior LLMs, for each value in vars dict
    if (node_type !== "chat" && showContToggle && contWithPriorLLMs) {
      // We need to draw the LLMs to query from the input responses
      _llmItemsCurrState = getLLMsInPulledInputData(pulled_vars);
    }
    if (node_type !== "chat" && showContToggle && contWithPriorRAGs) {
      _ragItemsCurrState = getLLMsInPulledInputData(pulled_vars);
    }

    // Check if there's at least one model in the list; if not, nothing to run on.
    if (
      (!_llmItemsCurrState || _llmItemsCurrState.length === 0) &&
      (!_ragItemsCurrState || _ragItemsCurrState.length === 0)
    ) {
      setRunTooltip("No LLMs/RAGs to query.");
      return;
    }

    const llms = _llmItemsCurrState.map((item) => item.model);
    const rags = _ragItemsCurrState.map((item) => item.model);
    const num_llms = llms.length + rags.length;

    // Fetch response counts from backend
    fetchResponseCounts(
      promptText,
      pulled_vars,
      _llmItemsCurrState,
      _ragItemsCurrState,
      chat_hist_by_llm,
    ).then((res) => {
      if (res === undefined) return;
      const [counts] = res;

      // Check for empty counts (means no requests will be sent!)
      const num_llms_missing = Object.keys(counts).length;
      if (num_llms_missing === 0) {
        setRunTooltip("Will load responses from cache");
        setResponsesWillChange(false);
        return;
      }

      setResponsesWillChange(true);

      // Tally how many queries per LLM:
      const queries_per_llm: Dict<number> = {};
      Object.keys(counts).forEach((llm_key) => {
        queries_per_llm[llm_key] = Object.keys(counts[llm_key]).reduce(
          (acc, prompt) => acc + counts[llm_key][prompt],
          0,
        );
      });

      // Check if all counts are the same:
      if (num_llms_missing > 1) {
        const some_llm_num = queries_per_llm[Object.keys(queries_per_llm)[0]];
        const all_same_num_queries = Object.keys(queries_per_llm).reduce(
          (acc, llm_key) => acc && queries_per_llm[llm_key] === some_llm_num,
          true,
        );
        if (num_llms_missing === num_llms && all_same_num_queries) {
          // Counts are the same
          const req = some_llm_num > 1 ? "requests" : "request";
          setRunTooltip(
            `Will send ${some_llm_num} new ${req}` +
              (num_llms > 1 ? " per LLM/RAG" : ""),
          );
        } else if (all_same_num_queries) {
          const req = some_llm_num > 1 ? "requests" : "request";
          setRunTooltip(
            `Will send ${some_llm_num} new ${req}` +
              (num_llms > 1 ? ` to ${num_llms_missing} LLMs/RAGs` : ""),
          );
        } else {
          // Counts are different
          const sum_queries = Object.keys(queries_per_llm).reduce(
            (acc, llm_key) => acc + queries_per_llm[llm_key],
            0,
          );
          setRunTooltip(
            `Will send a variable # of queries to LLM/RAG(s) (total=${sum_queries})`,
          );
        }
      } else {
        const llm_key = Object.keys(queries_per_llm)[0];
        const llm_name =
          llmListContainer?.current?.getLLMListItemForKey(llm_key)?.name;
        const llm_count = queries_per_llm[llm_key];
        const req = llm_count > 1 ? "queries" : "query";
        if (llm_name === undefined)
          setRunTooltip(`Will send ${llm_count} ${req} per LLM/RAG`);
        else if (num_llms > num_llms_missing)
          setRunTooltip(
            `Will send ${llm_count} ${req} to ${llm_name} and load others`,
          );
        else setRunTooltip(`Will send ${llm_count} ${req} to ${llm_name}`);
      }
    });
  };

  const handleRunClick = () => {
    // Go through all template hooks (if any) and check they're connected:
    const is_fully_connected = templateVars.every((varname) => {
      // Check that some edge has, as its target, this node and its template hook:
      return edges.some((e) => e.target === id && e.targetHandle === varname);
    });

    if (!is_fully_connected) {
      triggerAlert("Missing inputs to one or more template variables.");
      return;
    }

    // If this is a chat node, we need to pull chat histories:
    let [past_chat_llms, pulled_chats] =
      node_type === "chat" ? pullInputChats() : [undefined, undefined];
    let chat_hist_by_llm: Dict<ChatHistoryInfo[]> | undefined;

    past_chat_llms = past_chat_llms as (string | LLMSpec)[] | undefined;
    pulled_chats = pulled_chats as ChatHistoryInfo[] | undefined;

    let LlmRagJsonResponses: LLMResponse[] = [];
    let LlmRagCacheFiles: Dict<string | LLMSpec> = {};

    // If this is a chat node and 'continuing chat with prior LLMs' is checked,
    // there's no customizable model list (llmItemsCurrState). Instead, we need to get the unique
    // LLMs present by finding the set of 'llm' key with unique 'name' properties
    // in the input variables (if any). If there's keys present w/o LLMs (for instance a text node),
    // we need to pop-up an error message.
    let _llmItemsCurrState = llmItemsCurrState;
    if (node_type === "chat" && contWithPriorLLMs) {
      // If there's nothing attached to past conversations, we can't continue the chat:
      if (past_chat_llms === undefined || pulled_chats === undefined) {
        triggerAlert(
          `You need to attach an input to the Past Conversation message first. For instance, you might query 
multiple chat LLMs with a prompt node, and then attach the Prompt Node output to the
Past Conversation input of this Chat Turn node in order to continue the chat.`,
        );
        return;
      }

      // Check if pulled chats includes undefined content.
      // This could happen with Join nodes, where there is no longer a single "prompt" (user prompt)
      // of the chat provenance. Instead of blocking this behavior, we replace undefined with a blank string,
      // and output a warning to the console.
      if (
        !pulled_chats.every((c) =>
          c.messages.every((m) => m.content !== undefined),
        )
      ) {
        console.warn(
          `Chat history contains undefined content. This can happen if a Join Node was used, 
as there is no longer a single prompt as the provenance of the conversation. 
Soft failing by replacing undefined with empty strings.`,
        );
        pulled_chats.forEach((c) => {
          c.messages = c.messages.map((m) => {
            if (m.content !== undefined) return m;
            else return { ...m, content: " " }; // the string contains a single space since PaLM2 refuses to answer with empty strings
          });
        });
      }

      // Override LLM list with the past llm info (unique LLMs in prior responses)
      _llmItemsCurrState = past_chat_llms as LLMSpec[];

      // Now we need transform the 'pulled_chats' to be a dict indexed by LLM nicknames:
      chat_hist_by_llm = bucketChatHistoryInfosByLLM(pulled_chats);
    }

    // Pull the data to fill in template input variables, if any
    let pulled_data: Dict<(string | TemplateVarInfo)[]> = {};
    try {
      // Try to pull inputs
      pulled_data = pullInputData(templateVars, id);
    } catch (err) {
      if (showAlert) showAlert((err as Error)?.message ?? err);
      console.error(err);
      return; // early exit
    }

    const prompt_template = promptText;
    const _ragItemsCurrState = ragItemsCurrState;

    // Whether to continue with only the prior LLMs, for each value in vars dict
    if (node_type !== "chat" && showContToggle && contWithPriorLLMs) {
      // We need to draw the LLMs to query from the input responses
      _llmItemsCurrState = getLLMsInPulledInputData(pulled_data);
    }

    // Check that there is at least one LLM selected:
    if (_llmItemsCurrState.length === 0 && _ragItemsCurrState.length === 0) {
      window.alert("Please select at least one LLM or RAG to prompt.");
      return;
    }

    // Set status indicator
    setStatus(Status.LOADING);
    setContChatToggleDisabled(true);
    setJSONResponses([]);
    setProgressAnimated(true);

    const rejected = (err: Error | string) => {
      if (
        err instanceof UserForcedPrematureExit ||
        CancelTracker.has(cancelId)
      ) {
        // Handle a premature cancelation
        console.log("Canceled.");
      } else {
        setStatus(Status.ERROR);
        setContChatToggleDisabled(false);
        triggerAlert(typeof err === "string" ? err : err?.message);
      }
    };

    // Fetch info about the number of queries we'll need to make
    const fetch_resp_count = () =>
      fetchResponseCounts(
        prompt_template,
        pulled_data,
        _llmItemsCurrState,
        _ragItemsCurrState,
        pulled_chats as ChatHistoryInfo[],
      );

    // Initialize progress bars to small amounts
    setProgress({ success: 2, error: 0 });
    llmListContainer?.current?.setZeroPercProgress();
    ragListContainer?.current?.setZeroPercProgress();

    // Create a callback to listen for progress
    let onProgressChange:
      | ((progress_by_llm_key: Dict<QueryProgress>) => void)
      | undefined;
    const open_progress_listener = (
      res: undefined | [Dict<Dict<number>>, Dict<number>],
    ) => {
      if (res === undefined) return;
      const [response_counts, total_num_responses] = res;

      setResponsesWillChange(
        !response_counts || Object.keys(response_counts).length === 0,
      );

      const max_responses = Object.keys(total_num_responses).reduce(
        (acc, llm) => acc + total_num_responses[llm],
        0,
      );

      onProgressChange = (progress_by_llm_key: Dict<QueryProgress>) => {
        if (!progress_by_llm_key || CancelTracker.has(cancelId)) return;

        // Update individual progress bars
        const num_llms = _llmItemsCurrState.length;
        const num_rags = _ragItemsCurrState.length;
        const num_resp_per_llm = max_responses / (num_llms + num_rags);

        // Update total progress bar
        const total_num_success = Object.keys(progress_by_llm_key).reduce(
          (acc, llm_key) => {
            return acc + progress_by_llm_key[llm_key].success;
          },
          0,
        );
        const total_num_error = Object.keys(progress_by_llm_key).reduce(
          (acc, llm_key) => {
            return acc + progress_by_llm_key[llm_key].error;
          },
          0,
        );

        // Debounce the progress bars UI update to ensure we don't re-render too often:
        debounce(() => {
          llmListContainer?.current?.updateProgress((item: LLMSpec) => {
            if (item.key !== undefined && item.key in progress_by_llm_key) {
              item.progress = {
                success:
                  (progress_by_llm_key[item.key].success / num_resp_per_llm) *
                  100,
                error:
                  (progress_by_llm_key[item.key].error / num_resp_per_llm) *
                  100,
              };
            }
            return item;
          });
          ragListContainer?.current?.updateProgress((item: LLMSpec) => {
            if (item.key !== undefined && item.key in progress_by_llm_key) {
              item.progress = {
                success:
                  (progress_by_llm_key[item.key].success / num_resp_per_llm) *
                  100,
                error:
                  (progress_by_llm_key[item.key].error / num_resp_per_llm) *
                  100,
              };
            }
            return item;
          });

          setProgress({
            success: Math.max(5, (total_num_success / max_responses) * 100),
            error: (total_num_error / max_responses) * 100,
          });
        }, 30)();
      };
    };

    // Run all prompt permutations through the LLM to generate + cache responses:
    const query_llms = () => {
      if (_llmItemsCurrState.length > 0) {
        return queryLLM(
          id,
          _llmItemsCurrState, // deep clone it first
          numGenerations,
          prompt_template,
          pulled_data,
          chat_hist_by_llm,
          apiKeys || {},
          false,
          onProgressChange,
          node_type !== "chat"
            ? showContToggle && contWithPriorLLMs
            : undefined,
          cancelId,
        ).then(function (json) {
          // We have to early exit explicitly because we will still enter this function even if 'rejected' is called
          if (!json && CancelTracker.has(cancelId)) return;

          if (!_ragItemsCurrState || _ragItemsCurrState.length === 0) {
            // Remove progress bars
            setProgress(undefined);
            setProgressAnimated(false);
            // eslint-disable-next-line
            debounce(() => {}, 1)(); // erase any pending debounces
          }

          // Store and log responses (if any)
          if (json?.responses) {
            LlmRagJsonResponses = json.responses;
            setJSONResponses(LlmRagJsonResponses);

            // Log responses for debugging:
            // console.log(LlmRagJsonResponses);

            // Save response texts as 'fields' of data, for any prompt nodes pulling the outputs
            // We also need to store a unique metavar for the LLM *set* (set of LLM nicknames) that produced these responses,
            // so we can keep track of 'upstream' LLMs (and plot against them) later on:
            const llm_metavar_key = getUniqueLLMMetavarKey(LlmRagJsonResponses);

            setDataPropsForNode(id, {
              fields: LlmRagJsonResponses.map((resp_obj) =>
                resp_obj.responses.map((r) => {
                  // Carry over the response text, prompt, prompt fill history (vars), and llm nickname:
                  const o: TemplateVarInfo = {
                    text: typeof r === "string" ? escapeBraces(r) : undefined,
                    image:
                      typeof r === "object" && r.t === "img" ? r.d : undefined,
                    prompt: resp_obj.prompt,
                    fill_history: resp_obj.vars,
                    llm: _llmItemsCurrState.find(
                      (item) => item.name === resp_obj.llm,
                    ),
                    uid: resp_obj.uid,
                  };

                  // Carry over any metavars
                  o.metavars = resp_obj.metavars ?? {};

                  // Add a metavar for the prompt *template* in this PromptNode
                  o.metavars.__pt = prompt_template;

                  // Carry over any chat history
                  if (resp_obj.chat_history)
                    o.chat_history = resp_obj.chat_history;

                  // Add a meta var to keep track of which LLM produced this response
                  o.metavars[llm_metavar_key] =
                    typeof resp_obj.llm === "string"
                      ? resp_obj.llm
                      : resp_obj.llm.name;
                  return o;
                }),
              ).flat(),
            });
          }

          if (json?.cache) {
            LlmRagCacheFiles = json.cache;
          }
          // If there was at least one error collecting a response...
          const llms_w_errors = json?.errors ? Object.keys(json.errors) : [];
          if (llms_w_errors.length > 0) {
            // Remove the total progress bar
            setProgress(undefined);

            // Ensure there's a sliver of error displayed in the progress bar
            // of every LLM item that has an error:
            llmListContainer?.current?.ensureLLMItemsErrorProgress(
              llms_w_errors,
            );

            // Set error status
            setStatus(Status.ERROR);
            setContChatToggleDisabled(false);

            // Trigger alert and display one error message per LLM of all collected errors:
            let combined_err_msg = "";
            llms_w_errors.forEach((llm_key) => {
              const item = _llmItemsCurrState.find(
                (item) => item.key === llm_key,
              );
              combined_err_msg +=
                item?.name +
                ": " +
                JSON.stringify(json.errors[llm_key][0]) +
                "\n";
            });
            // We trigger the alert directly (don't use triggerAlert) here because we want to keep the progress bar:
            if (showAlert)
              showAlert(
                "Errors collecting responses. Re-run prompt node to retry.\n\n" +
                  combined_err_msg,
              );

            return;
          }

          if (responsesWillChange && !showDrawer) setUninspectedResponses(true);

          setResponsesWillChange(false);
          setContChatToggleDisabled(false);

          // Remove individual progress rings
          llmListContainer?.current?.resetLLMItemsProgress();

          // Save prompt text so we remember what prompt we have responses cache'd for:
          setPromptTextOnLastRun(promptText);
          setNumGenerationsLastRun(numGenerations);

          // All responses collected! Change status to 'ready':
          setStatus(Status.READY);

          // Ping any inspect nodes attached to this node to refresh their contents:
          pingOutputNodes(id);
        });
      }
    };

    // Run all prompt permutations through the RAG to generate + cache responses:
    const query_rags = () => {
      if (_ragItemsCurrState?.length > 0) {
        const data: any = {};
        const pulled_vars = getImmediateInputNode(
          ["rag_knowledge_base"],
          id,
        ).filter((t) => t.type === "uploadfilefields");
        data.index_path = `configurations/${urlParams.get("p_folder")}/${urlParams.get("i_folder")}`;
        data.query = pulled_data;
        data.uid = [];
        pulled_vars.forEach((node_obj) => {
          Object.keys(node_obj?.data?.fields)?.forEach((key) => {
            data.uid.push(
              node_obj.data.fields[key].split("/")[3].split("-")[1],
            );
          });
        });
        return queryRAG(
          id,
          _ragItemsCurrState, // deep clone it first
          prompt_template,
          data,
          [],
          false,
          onProgressChange,
          cancelId,
        ).then(function (json) {
          // We have to early exit explicitly because we will still enter this function even if 'rejected' is called
          if (!json && CancelTracker.has(cancelId)) return;

          // Remove progress bars
          setProgress(undefined);
          setProgressAnimated(false);
          // eslint-disable-next-line
          debounce(() => {}, 1)(); // erase any pending debounces

          // Store and log responses (if any)
          if (json?.responses) {
            if (LlmRagJsonResponses?.length > 0) {
              LlmRagJsonResponses = LlmRagJsonResponses.concat(json.responses);
            } else {
              LlmRagJsonResponses = json.responses;
            }
            setJSONResponses(LlmRagJsonResponses);

            // Log responses for debugging:
            // console.log(LlmRagJsonResponses);

            // Save response texts as 'fields' of data, for any prompt nodes pulling the outputs
            // We also need to store a unique metavar for the RAG *set* (set of RAG nicknames) that produced these responses,
            // so we can keep track of 'upstream' RAGs (and plot against them) later on:
            const rag_metavar_key = getUniqueRAGMetavarKey(LlmRagJsonResponses);

            setDataPropsForNode(id, {
              fields: LlmRagJsonResponses.map((resp_obj) =>
                resp_obj.responses.map((r) => {
                  // Carry over the response text, prompt, prompt fill history (vars), and rag nickname:
                  const o: TemplateVarInfo = {
                    text: typeof r === "string" ? escapeBraces(r) : undefined,
                    image:
                      typeof r === "object" && r.t === "img" ? r.d : undefined,
                    prompt: resp_obj.prompt,
                    fill_history: resp_obj.vars,
                    uid: resp_obj.uid,
                  };
                  // Carry over any metavars
                  o.metavars = resp_obj.metavars ?? {};
                  // Add a metavar for the prompt *template* in this PromptNode
                  o.metavars.__pt = prompt_template;
                  let temp: LLMSpec | undefined;
                  temp = _llmItemsCurrState.find(
                    (item) => item.name === resp_obj.llm,
                  );
                  if (temp) {
                    o.llm = temp;
                  } else {
                    temp = _ragItemsCurrState.find(
                      (item) => item.model === resp_obj.llm,
                    );
                    o.llm = temp;
                    // Add a meta var to keep track of which RAG produced this response
                    o.metavars[rag_metavar_key] =
                      typeof resp_obj.llm === "string"
                        ? resp_obj.llm
                        : resp_obj.llm.name;
                  }
                  // Carry over any chat history
                  if (resp_obj.chat_history)
                    o.chat_history = resp_obj.chat_history;
                  return o;
                }),
              ).flat(),
            });
          }

          if (json?.cache) {
            if (LlmRagCacheFiles) {
              LlmRagCacheFiles = { ...LlmRagCacheFiles, ...json.cache };
            } else {
              LlmRagCacheFiles = json.cache;
            }
          }

          caching_responses(LlmRagJsonResponses, LlmRagCacheFiles, id);

          // If there was at least one error collecting a response...
          const rags_w_errors = json?.errors ? Object.keys(json.errors) : [];
          if (rags_w_errors.length > 0) {
            // Remove the total progress bar
            setProgress(undefined);

            // Ensure there's a sliver of error displayed in the progress bar
            // of every RAG item that has an error:
            ragListContainer?.current?.ensureRAGItemsErrorProgress(
              rags_w_errors,
            );

            // Set error status
            setStatus(Status.ERROR);
            setContChatToggleDisabled(false);

            // Trigger alert and display one error message per RAG of all collected errors:
            let combined_err_msg = "";
            rags_w_errors.forEach((rag_key) => {
              const item = _ragItemsCurrState.find(
                (item) => item.key === rag_key,
              );
              combined_err_msg +=
                item?.name +
                ": " +
                JSON.stringify(json.errors[rag_key][0]) +
                "\n";
            });
            // We trigger the alert directly (don't use triggerAlert) here because we want to keep the progress bar:
            if (showAlert)
              showAlert(
                "Errors collecting responses. Re-run prompt node to retry.\n\n" +
                  combined_err_msg,
              );

            return;
          }

          if (responsesWillChange && !showDrawer) setUninspectedResponses(true);

          setResponsesWillChange(false);
          setContChatToggleDisabled(false);

          // Remove individual progress rings
          ragListContainer?.current?.resetRAGItemsProgress();

          // Save prompt text so we remember what prompt we have responses cache'd for:
          setPromptTextOnLastRun(promptText);
          setNumGenerationsLastRun(numGenerations);

          // All responses collected! Change status to 'ready':
          setStatus(Status.READY);

          // Ping any inspect nodes attached to this node to refresh their contents:
          pingOutputNodes(id);
        });
      }
    };

    // Now put it all together!
    fetch_resp_count()
      .then(open_progress_listener)
      .then(query_llms)
      .then(query_rags)
      .catch(rejected);
  };

  const handleStopClick = useCallback(() => {
    CancelTracker.add(cancelId);
    refreshCancelId();

    // Update UI to seem like it's been immediately canceled, even
    // though we cannot fully cancel the queryLLMs Promise.
    // Remove progress bars
    setProgress(undefined);
    setProgressAnimated(false);
    // eslint-disable-next-line
    debounce(() => {}, 1)(); // erase any pending debounces

    // Set error status
    setStatus(Status.NONE);
    setContChatToggleDisabled(false);
    llmListContainer?.current?.resetLLMItemsProgress();
  }, [cancelId, refreshCancelId]);

  const handleNumGenChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      let n: string | number = event.target.value;
      // @ts-expect-error The isNaN check on a string input is the correct approach to determining what we want, yet this will show an error in TS.
      if (!isNaN(n) && n.length > 0 && /^\d+$/.test(n)) {
        // n is an integer; save it
        n = parseInt(n);
        if (n !== numGenerationsLastRun && status === Status.READY)
          setStatus(Status.WARNING);
        setNumGenerations(n);
        setDataPropsForNode(id, { n });
      }
    },
    [numGenerationsLastRun, status],
  );

  const hideStatusIndicator = () => {
    if (status !== Status.NONE) setStatus(Status.NONE);
  };

  const indexFiles = () => {
    // Pull the input data
    let pulled_vars;
    const resp = [];
    let isFileUploaded = false;
    try {
      pulled_vars = getImmediateInputNode(["rag_knowledge_base"], id).filter(
        (t) => t.type === "uploadfilefields",
      );

      // latest change: checking if a file has been uploaded for creating index
      pulled_vars.forEach((node_obj: any) => {
        const fields = node_obj?.data?.fields;
        if (fields && Object.keys(fields).some((key) => fields[key])) {
          isFileUploaded = true;
          return;
        }
      });
      if (!isFileUploaded) {
        return;
      }
      ragListContainer?.current?.setZeroPercProgress();
      pulled_vars.forEach((node_obj) => {
        Object.keys(node_obj?.data?.fields)?.forEach((key) => {
          ragItemsCurrState.forEach(async (rag) => {
            try {
              let rag_params = {};
              if (typeof rag === "object" && rag.settings !== undefined)
                rag_params = rag.settings;

              const dataObj: any = {
                files_path: `configurations/${node_obj.data.fields[key]}`,
                rag_name: rag.model,
                settings: {
                  ...rag_params,
                  ...typecastRagSettingsDict(
                    {} as ModelSettingsDict,
                    rag.model,
                  ),
                },
              };
              dataObj.settings.index_name = `${dataObj.settings.index_name}__${node_obj.data.fields[key].split("/")[3].split("-")[1]}`;
              const response = await index_file(dataObj);
              resp.push(response);
              ragListContainer?.current?.updateProgress((item: LLMSpec) => {
                if (item.key !== undefined && item.key === rag.key) {
                  item.progress = { success: 100, error: 0 };
                }
                return item;
              });
              if (
                resp?.length > 0 &&
                resp?.length ===
                  Object.keys(node_obj?.data?.fields)?.length *
                    ragItemsCurrState.length
              ) {
                setTimeout(() => {
                  console.log("Resetting the rag items Progress");
                  ragListContainer?.current?.resetRAGItemsProgress();
                }, 3000);
              }
            } catch (err) {
              ragListContainer?.current?.updateProgress((item: LLMSpec) => {
                if (item.key !== undefined && item.key === rag.key) {
                  item.progress = { success: 0, error: 100 };
                }
                return item;
              });
              setRunTooltip("Error while indexing file.");
              console.error(err);
            }
          });
        });
      });
    } catch (err) {
      setRunTooltip("Error: Duplicate variables detected.");
      console.error(err);
    }
  };

  // Dynamically update the textareas and position of the template hooks
  const textAreaRef = useRef<HTMLTextAreaElement | HTMLDivElement | null>(null);
  const [hooksY, setHooksY] = useState(138);
  const setRef = useCallback(
    (elem: HTMLDivElement | HTMLTextAreaElement | null) => {
      if (!elem) return;
      // To listen for resize events of the textarea, we need to use a ResizeObserver.
      // We initialize the ResizeObserver only once, when the 'ref' is first set, and only on the div wrapping textfields.
      // NOTE: This won't work on older browsers, but there's no alternative solution.
      if (!textAreaRef.current && elem && window.ResizeObserver) {
        let past_hooks_y = 138;
        const incr = 68 + (node_type === "chat" ? -6 : 0);
        const observer = new window.ResizeObserver(() => {
          if (!textAreaRef || !textAreaRef.current) return;
          const new_hooks_y = textAreaRef.current.clientHeight + incr;
          if (past_hooks_y !== new_hooks_y) {
            setHooksY(new_hooks_y);
            past_hooks_y = new_hooks_y;
          }
        });

        observer.observe(elem);
        textAreaRef.current = elem;
      }
    },
    [textAreaRef],
  );

  // Add custom context menu options on right-click.
  // 1. Convert TextFields to Items Node, for convenience.
  const customContextMenuItems = useMemo(
    () => [
      {
        key: "clear_cache",
        icon: <IconEraser size="11pt" />,
        text: "Clear cached responses",
        onClick: () => {
          // Clear responses associated with this node
          clearCachedResponses(id);
          // Remove items and reset status
          setStatus(Status.NONE);
          setJSONResponses(null);
        },
      },
    ],
    [id],
  );

  return (
    <BaseNode
      classNames="prompt-node"
      nodeId={id}
      contextMenuExts={customContextMenuItems}
    >
      <NodeLabel
        title={data.title || node_default_title}
        nodeId={id}
        onEdit={hideStatusIndicator}
        icon={node_icon}
        status={status}
        isRunning={status === "loading"}
        handleRunClick={handleRunClick}
        handleStopClick={handleStopClick}
        handleRunHover={handleRunHover}
        runButtonTooltip={runTooltip}
        customButtons={[
          <PromptListPopover
            key="prompt-previews"
            promptInfos={promptPreviews}
            onHover={handlePreviewHover}
            onClick={openInfoModal}
          />,
        ]}
      />
      <LLMResponseInspectorModal
        ref={inspectModal}
        jsonResponses={jsonResponses ?? []}
      />
      <Modal
        title={
          "List of prompts that will be sent to LLMs (" +
          promptPreviews.length +
          " total)"
        }
        size="xl"
        opened={infoModalOpened}
        onClose={closeInfoModal}
        styles={{
          header: { backgroundColor: "#FFD700" },
          root: { position: "relative", left: "-5%" },
        }}
      >
        <Box m="lg" mt="xl">
          {displayPromptInfos(promptPreviews, true)}
        </Box>
      </Modal>

      {node_type === "chat" ? (
        <div ref={setRef}>
          <ChatHistoryView
            bgColors={["#ccc", "#ceeaf5b1"]}
            messages={[
              "(Past conversation)",
              <Textarea
                key={0}
                className="prompt-field-fixed nodrag nowheel"
                minRows={4}
                defaultValue={data.prompt}
                onChange={handleInputChange}
                miw={230}
                styles={{
                  input: { background: "transparent", borderWidth: "0px" },
                }}
              />,
            ]}
          />
          <Handle
            type="target"
            position={Position.Left}
            id="__past_chats"
            style={{ top: "82px", background: "#555" }}
          />
        </div>
      ) : (
        <Textarea
          ref={setRef}
          autosize
          className="prompt-field-fixed nodrag nowheel"
          minRows={4}
          maxRows={12}
          defaultValue={data.prompt}
          onChange={handleInputChange}
        />
      )}

      <Handle
        type="source"
        position={Position.Right}
        id="prompt"
        className="grouped-handle"
        style={{ top: "50%" }}
      />
      <TemplateHooks
        vars={templateVars}
        nodeId={id}
        startY={hooksY}
        position={Position.Left}
        ignoreHandles={["__past_chats"]}
      />
      <hr />
      <div>
        <div style={{ marginBottom: "10px", padding: "4px" }}>
          <label htmlFor="num-generations" style={{ fontSize: "10pt" }}>
            Num responses per prompt:&nbsp;
          </label>
          <input
            id="num-generations"
            name="num-generations"
            type="number"
            min={1}
            max={999}
            defaultValue={data.n || 1}
            onChange={handleNumGenChange}
            className="nodrag"
          ></input>
        </div>

        {showContToggle ? (
          <div>
            <Switch
              label={
                contWithPriorLLMs
                  ? "Continue with prior LLM(s)"
                  : "Continue with new LLMs:"
              }
              defaultChecked={true}
              checked={contWithPriorLLMs}
              disabled={contToggleDisabled}
              onChange={(event) => {
                setStatus(Status.WARNING);
                setContWithPriorLLMs(event.currentTarget.checked);
                setDataPropsForNode(id, {
                  contChat: event.currentTarget.checked,
                });
              }}
              color="cyan"
              size="xs"
              mb={contWithPriorLLMs ? "4px" : "10px"}
            />
          </div>
        ) : (
          <></>
        )}

        {!contWithPriorLLMs || !showContToggle ? (
          <div style={{ marginBottom: "10px" }}>
            <LLMListContainer
              ref={llmListContainer}
              initLLMItems={data.llms}
              onItemsChange={onLLMListItemsChange}
            />
          </div>
        ) : (
          <></>
        )}

        <hr />

        {/* {showContToggle ? (
          <div>
            <Switch
              label={
                contWithPriorRAGs
                  ? "Continue with prior RAG(s)"
                  : "Continue with new RAGs:"
              }
              defaultChecked={true}
              checked={contWithPriorRAGs}
              disabled={contToggleDisabled}
              onChange={(event) => {
                setStatus(Status.WARNING);
                setContWithPriorRAGs(event.currentTarget.checked);
                setDataPropsForNode(id, {
                  contChat: event.currentTarget.checked,
                });
              }}
              color="cyan"
              size="xs"
              mb={contWithPriorRAGs ? "4px" : "10px"}
            />
          </div>
        ) : (
          <></>
        )} */}
        {!contWithPriorRAGs || !showContToggle ? (
          <div>
            {/* {ragItemsCurrState?.length > 0 && (
              <Handle
                type="target"
                position={Position.Left}
                id="rag_knowledge_base"
                style={{
                  top: `${85 - ragItemsCurrState?.length}%`,
                  background: "#555",
                }}
              />
            )} */}
            <RAGListContainer
              ref={ragListContainer}
              initRAGItems={data.rags}
              onIndexBtnClick={indexFiles}
              onItemsChange={onRAGListItemsChange}
            />
          </div>
        ) : (
          <></>
        )}

        {progress !== undefined ? (
          <Progress
            animate={progressAnimated}
            sections={[
              {
                value: progress.success,
                color: "blue",
                tooltip: "API call succeeded",
              },
              {
                value: progress.error,
                color: "red",
                tooltip: "Error collecting response",
              },
            ]}
          />
        ) : (
          <></>
        )}

        {jsonResponses && jsonResponses.length > 0 && status !== "loading" ? (
          <InspectFooter
            onClick={showResponseInspector}
            isDrawerOpen={showDrawer}
            showDrawerButton={true}
            onDrawerClick={() => {
              setShowDrawer(!showDrawer);
              setUninspectedResponses(false);
              bringNodeToFront(id);
            }}
          />
        ) : (
          <></>
        )}
      </div>

      <LLMResponseInspectorDrawer
        jsonResponses={jsonResponses ?? []}
        showDrawer={showDrawer}
      />
    </BaseNode>
  );
};

export default PromptNode;
