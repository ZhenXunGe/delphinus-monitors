import BN from "bn.js";
import { readJSON, writeJSON, move } from "fs-extra";
import path from "path";
import {
  Groth16Proof,
  runZkp,
  zkpProofToArray,
} from "delphinus-zkp/src/circom/main";
import { Field } from "delphinus-curves/src/field";
import { withL1Client, L1Client } from "solidity/clients/client";
import { getEnabledEthConfigs } from "delphinus-deployment/src/config";
import { L1ClientRole } from "delphinus-deployment/src/types";
import { dataToBN } from "../client";
import { EventHandler } from "..";
import { L2Storage } from "delphinus-zkp/src/circom/address-space";
import { CommandOp } from "delphinus-l2-client-helper/src/swap";

const ProofPath = path.resolve(__dirname, "..", "..", "..");

function getProofPathOfRid(rid: string) {
  return path.resolve(ProofPath, `${rid}.proof`);
}

async function tryReadCachedProof(
  rid: string
): Promise<Groth16Proof | undefined> {
  const proofPath = getProofPathOfRid(rid);

  try {
    const proof = await readJSON(proofPath);
    console.log("Read the proof of rid ", rid, " from ", proofPath);
    return proof;
  } catch {
    return undefined;
  }
}

async function cacheProof(rid: string, proof: Groth16Proof) {
  const tmpProofPath = getProofPathOfRid("tmp");
  const proofPath = getProofPathOfRid(rid);

  /* Atomic writing */
  await writeJSON(tmpProofPath, proof);
  await move(tmpProofPath, proofPath);
}

async function withL2Storage<t>(cb: (_: L2Storage) => Promise<t>) {
  let l2Storage = new L2Storage();

  try {
    return await cb(l2Storage);
  } finally {
    await l2Storage.closeDb();
  }
}

async function preHandler(commitedRid: BN) {
}

async function verify(
  l1client: L1Client,
  command: number[],
  proof: BN[],
  rid: BN,
  vid: number = 0
) {
  console.log("start to send to:", l1client.getChainIdHex());
  while (true) {
    let txhash = "";
    try {
      let bridge = l1client.getBridgeContract();
      let metadata = await bridge.getMetaData();
      if (new BN(metadata.bridgeInfo.rid).gt(rid)) {
        return;
      }
      if (metadata.bridgeInfo.verifierID){
        vid = parseInt(metadata.bridgeInfo.verifierID);
      }

      /**
       * TODO: The exception behavior (e.g. network delay) will cause
       * the following statement to be executed multiple times,
       * thus consuming additional gas fee.
       *
       * We may introduce a db to filter out extra invoking.
       * 1. save (rid, txhash) into db
       * 2. check if the rid exists in the db
       * 3. get hash from db, and check if it is pending in eth
       */
      console.log("Current Verifier Version:" + vid);
      let tx = bridge.verify(command, proof, rid);
      let r = await tx.when("Verify", "transactionHash", (hash: string) => {
        console.log("Get transactionHash", hash);
        txhash = hash;
      });
      console.log("done", r.blockHash);
      return r;
    } catch (e: any) {
      if (txhash !== "") {
        console.log("exception with transactionHash ready", " will retry ...");
        console.log("exception with transactionHash ready", " will retry ...");
        throw e;
      } else {
        if (e.message == "ESOCKETTIMEDOUT") {
          await new Promise((resolve) => setTimeout(resolve, 5000));
        } else if (e.message == "nonce too low") {
          console.log("failed on:", l1client.getChainIdHex(), e.message); // not sure
          return;
        } else {
          console.log("Unhandled exception during verify");
          console.log(e);
          throw e;
        }
      }
    }
  }
}

export const batchSize = 10;
let pendingEvents: [Field, Field[]][] = [];

async function l1SyncHandler(rid: string, op: CommandOp, args: any[]) {
  pendingEvents.push([new Field(op), args.map(x => new Field(dataToBN(x)))]);

  if (pendingEvents.length < batchSize) {
    return;
  }

  const batchEvents = pendingEvents;
  pendingEvents = [];

  await withL2Storage(async (storage: L2Storage) => {
    let proof = await tryReadCachedProof(rid);
    if (!proof) {
      let lastRid = parseInt(rid) - batchSize;
      console.log("checkout db snapshot to", lastRid.toString(10));
      await withL2Storage(async (storage: L2Storage) => {
        await storage.loadSnapshot(lastRid.toString(10));
      });

      await storage.startSnapshot(rid);
      proof = await runZkp(
          batchEvents,
          storage,
          rid,
          true
        );
      cacheProof(rid, proof!);
      await storage.endSnapshot();
    }

    const proofArray = zkpProofToArray(proof!);
    const commandBuffer = batchEvents.map(
      e => [
        e[0].v.toArray('be', 1),
        e[1][3].v.toArray('be', 8),
        e[1][4].v.toArray('be', 4),
        e[1][5].v.toArray('be', 4),
        e[1][6].v.toArray('be', 32),
        e[1][7].v.toArray('be', 32)
      ]).flat(2);
    const proofBuffer = proofArray.map(x => new BN(x));

    console.log("\n----- verify args -----");
    console.log("current rid:", new BN(rid, 10).toString());
    console.log("commandBuffer:\n", commandBuffer.map(x => x.toString()));
    console.log("proofBuffer:\n", proofBuffer.map(x => x.toString()));
    console.log("----- verify args -----\n");

    for (const config of await getEnabledEthConfigs(L1ClientRole.Monitor)) {
      await withL1Client(config, false, (l1client: L1Client) => {
        return verify(
          l1client,
          commandBuffer,
          proofBuffer,
          new BN(rid, 10).subn(batchSize)
        );
      });
    }
  });
}

export const handler: EventHandler = {
  preHandler: preHandler,
  eventHandler: l1SyncHandler,
};
