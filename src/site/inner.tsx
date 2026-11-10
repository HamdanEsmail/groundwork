// Shared shell of the inner screens: blue title band, one column of sheets,
// optional address form. No index rail.
import type { Child } from "hono/jsx";
import { AskButton } from "./components";
import { Layout } from "./layout";

export function AskForm() {
  return (
    <form class="ask" action="/go" method="post">
      <label for="address">Address or OPA account</label>
      <input id="address" name="address" placeholder="1234 Market St" autocomplete="off" required maxlength={200} />
      <AskButton />
    </form>
  );
}

export function SheetBlock(props: { title: string; id?: string; no?: string; children?: Child }) {
  return (
    <article class="sh rise" id={props.id}>
      <header>
        {props.no ? <p class="no">{props.no}</p> : null}
        <h2>{props.title}</h2>
      </header>
      {props.children}
    </article>
  );
}

export function InnerPage(props: {
  heading: string;
  sentence: string;
  title: string;
  description: string;
  pageUrl: string;
  base: string;
  block?: { label: string; value: string }[];
  form?: boolean;
  close?: boolean;
  children?: Child;
}) {
  return (
    <Layout
      title={props.title}
      description={props.description}
      inner
      pageUrl={props.pageUrl}
      base={props.base}
    >
      <main>
        <div class="title">
          <h1>{props.heading}</h1>
          <p class="city">{props.sentence}</p>
          {props.block ? (
            <dl class="block">
              {props.block.map((it) => (
                <div>
                  <dt>{it.label}</dt>
                  <dd>{it.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {props.form ? <AskForm /> : null}
        </div>
        {props.children ? (
          <div class="set solo">
            <div class="sheets">{props.children}</div>
          </div>
        ) : null}
        {props.close ? <CloseBand /> : null}
      </main>
    </Layout>
  );
}

function CloseBand() {
  return (
    <section class="close" aria-label="Start">
      <div class="trio">
        <span>
          <img src="/assets/plates/hosiery.jpg" alt="Plan of the Germantown Hosiery Mills, 1866" style="object-position:40% 45%" loading="lazy" />
        </span>
        <span>
          <img src="/assets/plates/glen-echo.jpg" alt="Plan of the Glen Echo Mills, 1866" style="object-position:50% 50%" loading="lazy" />
        </span>
        <span>
          <img src="/assets/plates/carriage.jpg" alt="Plan of a carriage works, 1866" style="object-position:50% 60%" loading="lazy" />
        </span>
      </div>
      <div class="band">
        <p class="big rise">Before you buy, build or renovate, read what the city holds on the address.</p>
        <AskForm />
      </div>
    </section>
  );
}

export function NotFoundPage(props: { pageUrl: string; base: string }) {
  return (
    <InnerPage
      heading="NO SUCH SHEET"
      sentence="Nothing is filed at this address of the site."
      title="No such sheet: Groundwork"
      description="Nothing is filed at this address of the site."
      pageUrl={props.pageUrl}
      base={props.base}
      form
    />
  );
}

