import express = require("express");
import asyncHandler = require("express-async-handler");
import jsonld = require("jsonld");
import { DOMAIN, EVENT_STORAGE, FRAGMENT_STORAGE, FRAGMENTATION_STORAGE, STREAM_STORAGE } from "../config";
import EntityStatus from "../entities/EntityStatus";
import RDFEvent from "../entities/Event";
import EventStream from "../entities/EventStream";
import createStrategy from "../util/createStrategy";

const router = express.Router();

// GET /data/:streamName/:fragmentationName/:fragment
router.get("/:streamName/:fragmentationName/:fragment", asyncHandler(async (req, res) => {
    const streamName = req.params.streamName;
    const fragmentationName = req.params.fragmentationName;
    const fragment = req.params.fragment;
    const since = req.query.since;
    const limit = 250;

    const stream = await STREAM_STORAGE.getByName(streamName);
    if (!stream) {
        throw new Error("Stream name is invalid");
    }

    const canonicalStream = await STREAM_STORAGE.getByID(stream.sourceURI);
    const collectionURL = createCollectionURL(DOMAIN, stream.name);
    const canonicalURL = createFragmentURL(DOMAIN, stream.name, fragmentationName, fragment);
    if (since) {
        canonicalURL.searchParams.append("since", since);
    }

    if (streamName !== canonicalStream?.name) {
        // requested this resource under a different name
        res.redirect(301, canonicalURL);
        return;
    }

    const fragmentation = await FRAGMENTATION_STORAGE.getByName(stream.sourceURI, fragmentationName);
    if (!fragmentation || fragmentation.status === EntityStatus.DISABLED) {
        throw new Error("Fragmentation name is invalid");
    }

    const g = EVENT_STORAGE.getAllByFragment(
        stream.sourceURI,
        fragmentationName,
        fragment,
        since,
    );

    let firstTime: Date | undefined;
    let lastTime: Date | undefined;
    const events: RDFEvent[] = [];

    let withNext = false;
    for await (const event of g) {
        if (!firstTime) {
            firstTime = event.timestamp;
        }

        lastTime = event.timestamp;

        events.push(event);
        if (events.length >= 2000) {
            // hard limit on 2000 events/page
            // there is no next page
            break;
        } else if (events.length >= limit && firstTime?.toISOString() !== lastTime.toISOString()) {
            // we stopped because the page is full
            // not because we ran out of data
            withNext = true;
            break;
        }
    }

    const quads = events.flatMap((e) => e.data);
    const payload: any[] = await jsonld.fromRDF(quads);
    payload.unshift({
        "@id": collectionURL,
        "https://w3id.org/tree#view": canonicalURL,
        "https://w3id.org/tree#member": payload.map((e) => {
            return { "@id": e["@id"] };
        }),
    });

    const relations: any[] = [];
    const strategy = createStrategy(fragmentation);
    const fragmentGen = FRAGMENT_STORAGE.getRelationsByFragment(stream.sourceURI, fragmentationName, fragment);
    for await (const frag of fragmentGen) {
        relations.push({
            "@type": strategy.getRelationType(),
            "https://w3id.org/tree#node": {
                "@id": createFragmentURL(DOMAIN, streamName, fragmentationName, frag.value),
                "https://w3id.org/tree#remainingItems": frag.count,
            },
            "https://w3id.org/tree#path": fragmentation.shaclPath.map((p) => {
                return { "@id": p };
            }),
            "https://w3id.org/tree#value": {
                "@value": frag.value,
                "@type": frag.dataType,
            },
        });
    }

    if (withNext && lastTime) {
        const nextPath = createFragmentURL(DOMAIN, stream.name, fragmentationName, fragment);
        relations.push(buildNextRelation(stream, nextPath, lastTime));
    }

    const blob = {
        "@id": canonicalURL,
        "https://w3id.org/tree#relation": relations,
        "@included": payload,
    };

    res.type("application/ld+json; charset=utf-8");
    res.send(blob);
}));

// GET /data/:streamName/:fragmentationName
router.get("/:streamName/:fragmentationName", asyncHandler(async (req, res) => {
    const streamName = req.params.streamName;
    const fragmentationName: string = req.params.fragmentationName;

    const stream = await STREAM_STORAGE.getByName(streamName);
    if (!stream) {
        throw new Error("Stream name is invalid");
    }

    const canonicalStream = await STREAM_STORAGE.getByID(stream.sourceURI);
    const collectionURL = createCollectionURL(DOMAIN, streamName);
    const canonicalURL = createFragmentationURL(DOMAIN, streamName, fragmentationName);
    if (streamName !== canonicalStream?.name) {
        res.redirect(301, canonicalURL);
        return;
    }

    const fragmentation = await FRAGMENTATION_STORAGE.getByName(stream.sourceURI, fragmentationName);
    if (!fragmentation || fragmentation.status === EntityStatus.DISABLED) {
        throw new Error("Fragmentation name is invalid");
    }

    const strategy = createStrategy(fragmentation);

    const payload: any[] = [];
    payload.push({
        "@id": collectionURL,
        "https://w3id.org/tree#view": canonicalURL,
    });

    const relations: any[] = [];
    for await (const frag of FRAGMENT_STORAGE.getRootsByFragmentation(stream.sourceURI, fragmentationName)) {
        relations.push({
            "@type": strategy.getRelationType(),
            "https://w3id.org/tree#node": {
                "@id": createFragmentURL(DOMAIN, streamName, fragmentationName, frag.value),
                "https://w3id.org/tree#remainingItems": frag.count,
            },
            "https://w3id.org/tree#path": fragmentation.shaclPath.map((p) => {
                return { "@id": p };
            }),
            "https://w3id.org/tree#value": {
                "@value": frag.value,
                "@type": frag.dataType,
            },
        });
    }

    const blob = {
        "@id": canonicalURL,
        "https://w3id.org/tree#relation": relations,
        "@included": payload,
    };

    res.type("application/ld+json; charset=utf-8");
    res.send(blob);
}));

// GET /data/:streamName
router.get("/:streamName", asyncHandler(async (req, res) => {
    const streamName = req.params.streamName;
    const since = req.query.since;
    const limit = 250;
    const hardLimit = 2000;

    const stream = await STREAM_STORAGE.getByName(streamName);
    if (!stream) {
        throw new Error("Stream name is invalid");
    }

    const canonicalStream = await STREAM_STORAGE.getByID(stream.sourceURI);
    const collectionURL = createCollectionURL(DOMAIN, stream.name);
    const canonicalURL = createCollectionURL(DOMAIN, stream.name);
    if (since) {
        canonicalURL.searchParams.append("since", since);
    }

    if (streamName !== canonicalStream?.name) {
        // requested this resource under a different name
        res.redirect(301, canonicalURL);
        return;
    }

    const g = EVENT_STORAGE.getAllByStream(
        stream.sourceURI,
        since,
    );

    let firstTime: Date | undefined;
    let lastTime: Date | undefined;
    const events: RDFEvent[] = [];

    let exhausted = true;
    for await (const event of g) {
        if (!firstTime) {
            firstTime = event.timestamp;
        }

        lastTime = event.timestamp;

        events.push(event);
        if ((events.length >= limit && firstTime?.toISOString() !== lastTime.toISOString()) ||
            events.length >= hardLimit) {
            // we stopped because the page is full
            // not because we ran out of data
            exhausted = false;
            break;
        }
    }

    const quads = events.flatMap((e) => e.data);
    const payload: any[] = await jsonld.fromRDF(quads);
    payload.unshift({
        "@id": collectionURL,
        "https://w3id.org/tree#view": canonicalURL,
        "https://w3id.org/tree#member": payload.map((e) => {
            return { "@id": e["@id"] };
        }),
    });

    const relations: any[] = [];
    const blob = {
        "@id": canonicalURL,
        "https://w3id.org/tree#relation": relations,
        "@included": payload,
    };

    if (!exhausted && lastTime) {
        const nextPath = createCollectionURL(DOMAIN, stream.name);
        relations.push(buildNextRelation(stream, nextPath, lastTime));
    }

    res.type("application/ld+json; charset=utf-8");
    res.send(blob);
}));

function buildNextRelation(stream: EventStream, nextURL: URL, time: Date) {
    nextURL.searchParams.append("since", time.toISOString());
    return {
        "@type": "https://w3id.org/tree#GreaterOrEqualThanRelation",
        "https://w3id.org/tree#node": {
            "@id": nextURL,
        },
        "https://w3id.org/tree#path": stream.timeProperty.map((p) => {
            return { "@id": p };
        }),
        "https://w3id.org/tree#value": {
            "@value": time.toISOString(),
            "@type": "http://www.w3.org/2001/XMLSchema#dateTime",
        },
    };
}

function createCollectionURL(base: string, streamName: string): URL {
    return new URL(`/data/${streamName}`, base);
}

function createFragmentationURL(
    base: string,
    streamName: string,
    fragmentationName: string,
): URL {
    return new URL(`/data/${streamName}/${fragmentationName}`, base);
}

function createFragmentURL(
    base: string,
    streamName: string,
    fragmentationName: string,
    bucketValue: string,
): URL {
    return new URL(`/data/${streamName}/${fragmentationName}/${bucketValue}`, base);
}

export default router;
