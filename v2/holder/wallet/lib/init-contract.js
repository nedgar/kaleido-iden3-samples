const http = require('http');
const {
  CredentialWallet,
  IdentityWallet,
  KMS,
  BjjProvider,
  KmsKeyType,
  InMemoryPrivateKeyStore,
  InMemoryDataSource,
  CredentialStorage,
  IdentityStorage,
  InMemoryMerkleTreeStorage,
  EthStateStorage,
  ProofService,
  defaultEthConnectionConfig,
} = require('@0xpolygonid/js-sdk');
const { JsonRpcProvider } = require('@ethersproject/providers');
const { Wallet } = require('@ethersproject/wallet');
const nock = require('nock');
const { IdentityManager } = require('./identity');
const { initCircuitStorage } = require('./util');
const config = require('./config');

// This is a workaround.
// The State contract has a bug where it doesn't work properly if the GIST data is empty,
// prime a new contract with some states for a dummy credential to allow it to work properly
async function initializeStateContract() {
  let conf = Object.assign({}, defaultEthConnectionConfig);
  Object.assign(conf, config['kaleido']);

  const memoryKeyStore = new InMemoryPrivateKeyStore();
  const bjjProvider = new BjjProvider(KmsKeyType.BabyJubJub, memoryKeyStore);
  const kms = new KMS();
  kms.registerKeyProvider(KmsKeyType.BabyJubJub, bjjProvider);
  const circuitStorage = await initCircuitStorage();

  const dataStorage = {
    credential: new CredentialStorage(new InMemoryDataSource()),
    identity: new IdentityStorage(new InMemoryDataSource(), new InMemoryDataSource()),
    mt: new InMemoryMerkleTreeStorage(40),
    states: new EthStateStorage(conf),
  };

  const credWallet = new CredentialWallet(dataStorage);
  const idWallet = new IdentityWallet(kms, dataStorage, credWallet);
  const proofService = new ProofService(idWallet, credWallet, circuitStorage, dataStorage.states);

  const rhsUrl = 'https://rhs-staging.polygonid.me';
  const revStatusUrl = 'http://mytestwallet.com';
  nock(revStatusUrl)
    .get(/revocation\/.+/)
    .times(3)
    .reply(200, {
      mtp: {
        existence: false,
        siblings: [],
      },
    });
  nock(revStatusUrl).post('/node').reply(200);
  const seedPhraseIssuer = new TextEncoder().encode('seedseedseedseedseedseedseedseed');
  const seedPhraseUser = new TextEncoder().encode('seedseedseedseedseedseedseeduser');

  console.log('=> Creating temporary issuer identity');
  const { did: issuerDID, credential: issuerAuthCredential } = await idWallet.createIdentity('http://mytestwallet.com/', {
    method: 'iden3',
    seed: seedPhraseIssuer,
    rhsUrl,
  });
  console.log('=> Creating temporary holder identity');
  const { did: userDID, credential: cred } = await idWallet.createIdentity('http://mytestwallet.com/', {
    method: 'iden3',
    seed: seedPhraseUser,
    rhsUrl,
  });
  console.log('=> Issuing a credential');
  const claimReq = {
    credentialSchema: 'https://raw.githubusercontent.com/iden3/claim-schema-vocab/main/schemas/json/KYCAgeCredential-v2.json',
    type: 'KYCAgeCredential',
    credentialSubject: {
      id: userDID.toString(),
      birthday: 19960424,
      documentType: 99,
    },
    expiration: 1693526400,
    revNonce: 0,
  };
  const credential = await idWallet.issueCredential(issuerDID, claimReq, 'http://mytestwallet.com/', { withRHS: rhsUrl });
  console.log('=> Saving the new credential to the credential wallet');
  await credWallet.save(credential);
  console.log('=> Adding the new credential to the merkle tree');
  const res = await idWallet.addCredentialsToMerkleTree([credential], issuerDID);
  console.log('=> Publishing the new state to the revocation service');
  await idWallet.publishStateToRHS(issuerDID, rhsUrl);

  const provider = new JsonRpcProvider(conf.url);
  const signer = new Wallet(conf.privateKey, provider);
  console.log('=> Uploading the new state to blockchain');
  const txId = await proofService.transitState(issuerDID, res.oldTreeState, true, dataStorage.states, signer);
  console.log(`\tTransaction ID: ${txId}`);
}

module.exports = {
  initializeStateContract,
};