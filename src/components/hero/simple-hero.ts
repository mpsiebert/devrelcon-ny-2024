import { html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { heroSettings } from '../../utils/data';
import { ThemedElement } from '../themed-element';
import './hero-block';

type HeroKeys = keyof typeof heroSettings;
type SimpleHeroKeys = Extract<
  HeroKeys,
  | 'coc'
  | 'blog'
  | 'convinceYourBoss'
  | 'faq'
  | 'getInvolved'
  | 'notFound'
  | 'schedule'
  | 'speakers'
  | 'team'
  | 'neighborhood'
>;

interface Description {
  description: string;
}

interface DescriptionHtml {
  descriptionHtml: string;
}

interface Title {
  title: string;
}

const hasDescription = (setting: Description | {}): setting is Description => {
  return 'description' in setting;
};

const hasTitle = (setting: Title | {}): setting is Title => {
  return 'title' in setting;
};

@customElement('simple-hero')
export class SimpleHero extends ThemedElement {
  @property()
  page: SimpleHeroKeys = 'notFound';

  private renderDescription() {
    const setting = heroSettings[this.page];
    if ('descriptionHtml' in setting) {
      return html`<p class="hero-description">
        ${unsafeHTML((setting as DescriptionHtml).descriptionHtml)}
      </p>`;
    } else if (hasDescription(setting)) {
      return html`<p class="hero-description">
        ${(setting as Description).description}
      </p>`;
    } else {
      return nothing;
    }
  }

  private renderTitle() {
    if (hasTitle(heroSettings[this.page])) {
      return html`<div class="hero-title">${(heroSettings[this.page] as Title).title}</div>`;
    } else {
      return nothing;
    }
  }

  override render() {
    return html`
      <hero-block
        background-color="${heroSettings[this.page].background.color}"
        font-color="${heroSettings[this.page].fontColor}"
      >
        ${this.renderTitle()} ${this.renderDescription()}

        <slot></slot>
      </hero-block>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'simple-hero': SimpleHero;
  }
}
